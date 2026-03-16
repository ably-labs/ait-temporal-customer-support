import { Context, CancelledFailure } from '@temporalio/activity';
import { getRealtimeClient, createSessionRealtimeClient, channelName } from './ably-clients';
import { streamClaude } from './llm';
import type { Message } from './workflows';

export interface OneShotActivities {
  processLLMLocally(
    sessionId: string,
    taskId: string,
    messages: Message[],
  ): Promise<{ accumulatedText: string; cancelled: boolean }>;

  waitForPredecessor(
    sessionId: string,
    taskId: string,
    predecessorTaskId: string,
  ): Promise<'ready' | 'stopped'>;

  deliverAccumulated(
    sessionId: string,
    taskId: string,
    accumulatedText: string,
  ): Promise<void>;

  mergeContextBack(
    sessionId: string,
    messages: Message[],
  ): Promise<void>;
}

/**
 * Process LLM locally — streams Claude response, accumulates text in memory.
 * Enters presence with taskId so the frontend can track this parallel task.
 * Handles tool calls inline (single round for one-shot tasks).
 */
export async function processLLMLocally(
  sessionId: string,
  taskId: string,
  messages: Message[],
): Promise<{ accumulatedText: string; cancelled: boolean }> {
  const sessionClient = createSessionRealtimeClient(sessionId, taskId);
  const presenceChannel = sessionClient.channels.get(channelName(sessionId));

  try {
    await presenceChannel.presence.enter({ status: 'processing', taskId });

    const abortController = new AbortController();
    const temporalCancelSignal = Context.current().cancellationSignal;
    const onTemporalCancel = () => abortController.abort();
    if (temporalCancelSignal.aborted) {
      abortController.abort();
    } else {
      temporalCancelSignal.addEventListener('abort', onTemporalCancel);
    }

    // Also listen for control messages (stop)
    const realtime = getRealtimeClient();
    const realtimeChannel = realtime.channels.get(channelName(sessionId));
    const controlHandler = () => { abortController.abort(); };
    await realtimeChannel.subscribe('control', controlHandler);

    let accumulatedText = '';
    let cancelled = false;

    try {
      const llmResult = await streamClaude(messages, {
        onToken: (text) => {
          accumulatedText += text;
        },
        heartbeat: () => Context.current().heartbeat(),
        abortSignal: abortController.signal,
      });

      if (abortController.signal.aborted) {
        cancelled = true;
      } else {
        accumulatedText = llmResult.fullText;

        // Handle tool calls inline for one-shot (simple single-round)
        if (llmResult.type === 'tool_use' && llmResult.toolName && llmResult.toolInput) {
          // Publish tool status
          const channel = realtimeChannel;
          await channel.publish({
            name: 'tool',
            data: JSON.stringify({
              toolName: llmResult.toolName,
              input: llmResult.toolInput,
              status: 'calling',
              taskId,
            }),
          });

          // Execute tool (simplified inline)
          const toolResult = executeToolInline(llmResult.toolName, llmResult.toolInput);

          // Follow-up LLM call with tool results
          const followUpMessages: Message[] = [
            ...messages,
            {
              role: 'assistant',
              content: llmResult.fullText,
              rawContentBlocks: llmResult.rawContentBlocks,
            },
            {
              role: 'tool',
              content: JSON.stringify(toolResult),
              toolName: llmResult.toolName,
              toolUseId: llmResult.toolUseId,
            },
          ];

          let followUpText = '';
          const followUp = await streamClaude(followUpMessages, {
            onToken: (text) => { followUpText += text; },
            heartbeat: () => Context.current().heartbeat(),
            abortSignal: abortController.signal,
          });

          accumulatedText = followUp.fullText || followUpText;
        }
      }
    } finally {
      realtimeChannel.unsubscribe('control', controlHandler);
      temporalCancelSignal.removeEventListener('abort', onTemporalCancel);
    }

    await presenceChannel.presence.leave({ status: 'waiting-to-deliver', taskId });
    return { accumulatedText, cancelled };
  } catch (err) {
    if (err instanceof CancelledFailure) {
      await presenceChannel.presence.leave({ taskId });
      return { accumulatedText: '', cancelled: true };
    }
    throw err;
  } finally {
    sessionClient.close();
  }
}

/**
 * Wait for the predecessor task to finish delivering before we deliver ours.
 * Enters presence as 'waiting-to-deliver', polls for predecessor absence.
 */
export async function waitForPredecessor(
  sessionId: string,
  taskId: string,
  predecessorTaskId: string,
): Promise<'ready' | 'stopped'> {
  const sessionClient = createSessionRealtimeClient(sessionId, taskId);
  const presenceChannel = sessionClient.channels.get(channelName(sessionId));
  const selfClientIdPrefix = `ai-agent:${sessionId}:${taskId}`;

  try {
    await presenceChannel.presence.enter({ status: 'waiting-to-deliver', taskId });

    // Poll for predecessor absence (check every 500ms, up to 60s)
    const maxWaitMs = 60_000;
    const pollIntervalMs = 500;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      Context.current().heartbeat('waiting for predecessor');

      // Check cancellation
      if (Context.current().cancellationSignal.aborted) {
        await presenceChannel.presence.leave({ taskId });
        return 'stopped';
      }

      const members = await presenceChannel.presence.get();

      // Check if predecessor is still present
      const predecessorPrefix = predecessorTaskId === 'primary'
        ? `ai-agent:${sessionId}`
        : `ai-agent:${sessionId}:${predecessorTaskId}`;

      const predecessorPresent = members.some((m) => {
        const cid = m.clientId ?? '';
        // Match predecessor prefix but exclude self
        if (!cid.startsWith(predecessorPrefix)) return false;
        if (cid.startsWith(selfClientIdPrefix)) return false;
        // For 'primary' predecessor, exclude any taskId-scoped members
        // ai-agent:session matches, ai-agent:session:taskX does not
        if (predecessorTaskId === 'primary' && cid !== predecessorPrefix) return false;
        return true;
      });

      if (!predecessorPresent) {
        await presenceChannel.presence.leave({ status: 'delivering', taskId });
        return 'ready';
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Timeout — deliver anyway
    await presenceChannel.presence.leave({ status: 'delivering', taskId });
    return 'ready';
  } finally {
    sessionClient.close();
  }
}

/**
 * Deliver the accumulated response to the Ably channel.
 * Creates a response message and rapidly appends chunks, then marks complete.
 */
export async function deliverAccumulated(
  sessionId: string,
  taskId: string,
  accumulatedText: string,
): Promise<void> {
  const sessionClient = createSessionRealtimeClient(sessionId, taskId);
  const presenceChannel = sessionClient.channels.get(channelName(sessionId));

  try {
    await presenceChannel.presence.enter({ status: 'delivering', taskId });

    const realtime = getRealtimeClient();
    const channel = realtime.channels.get(channelName(sessionId));

    // Create the response message
    const result = await channel.publish({ name: 'response', data: '' });
    const msgSerial = result.serials[0];
    if (!msgSerial) throw new Error('Failed to get serial from publish');

    // Rapidly append chunks (simulate streaming for smooth UX)
    const chunkSize = 20;
    const appendPromises: Promise<unknown>[] = [];
    for (let i = 0; i < accumulatedText.length; i += chunkSize) {
      const chunk = accumulatedText.slice(i, i + chunkSize);
      appendPromises.push(channel.appendMessage({ serial: msgSerial, data: chunk }));
    }

    const results = await Promise.allSettled(appendPromises);
    const anyFailed = results.some((r) => r.status === 'rejected');
    if (anyFailed) {
      await channel.updateMessage({ serial: msgSerial, data: accumulatedText });
    }

    // Mark complete with taskId header
    await channel.updateMessage({
      serial: msgSerial,
      extras: { headers: { status: 'complete', next: 'text', taskId } },
    });

    await presenceChannel.presence.leave({ status: 'delivered', taskId });
  } finally {
    sessionClient.close();
  }
}

/**
 * Merge the one-shot conversation context back into the primary workflow.
 * Signals the primary workflow's mergeContext signal.
 */
export async function mergeContextBack(
  sessionId: string,
  messages: Message[],
): Promise<void> {
  // Import temporal client dynamically to avoid circular deps in worker context
  // Use REST to signal the primary workflow via Temporal client
  const { getTemporalClient } = await import('@/lib/temporal-client');
  const client = await getTemporalClient();
  try {
    const handle = client.workflow.getHandle(`support-${sessionId}`);
    await handle.signal('mergeContext', { messages });
  } catch (err) {
    console.warn(`Failed to merge context back: ${err instanceof Error ? err.message : 'Unknown'}`);
  }
}

/**
 * Simple inline tool execution for one-shot workflows.
 * Mirrors the tool implementations in activities.ts but without presence/progress.
 */
function executeToolInline(toolName: string, toolInput: Record<string, unknown>): unknown {
  switch (toolName) {
    case 'lookupOrder':
      return {
        orderId: toolInput.orderId,
        status: 'shipped',
        trackingNumber: 'TRK-12345-MOCK',
        estimatedDelivery: '2026-03-10',
      };
    case 'checkRefundStatus':
      return { refundId: toolInput.refundId, status: 'processing', estimatedCompletion: '3-5 business days' };
    case 'getAccountDetails':
      return { customerId: toolInput.customerId, name: 'Jane Doe', plan: 'Pro', memberSince: '2024-01' };
    case 'doResearch':
      return {
        topic: toolInput.topic,
        findings: [
          'Found 3 related support tickets from other customers',
          'Product documentation confirms this is a known limitation',
          'Engineering team has a fix scheduled for next release (v2.4)',
        ],
        recommendation: 'Apply the workaround now, permanent fix coming in v2.4.',
      };
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
