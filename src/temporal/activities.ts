import { Context, CancelledFailure } from '@temporalio/activity';
import { getRealtimeClient, getRestClient, getSessionRealtimeClient, closeSessionClient, channelName } from './ably-clients';
import { streamClaude } from './llm';
import type { Message } from './workflows';

/**
 * Cancellation-aware sleep that responds to both Temporal cancellation
 * (CancellationScope.cancel()) and Ably control messages.
 * Throws CancelledFailure when cancelled, allowing the activity to exit early.
 */
function cancellableSleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Check if already cancelled
    const cancelSignal = Context.current().cancellationSignal;
    if (cancelSignal.aborted || abortSignal?.aborted) {
      reject(new CancelledFailure('Activity cancelled'));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onCancel = () => {
      clearTimeout(timer);
      cleanup();
      reject(new CancelledFailure('Activity cancelled'));
    };

    const cleanup = () => {
      cancelSignal.removeEventListener('abort', onCancel);
      abortSignal?.removeEventListener('abort', onCancel);
    };

    cancelSignal.addEventListener('abort', onCancel);
    abortSignal?.addEventListener('abort', onCancel);
  });
}

export interface LLMResult {
  type: 'text' | 'tool_use' | 'escalate';
  fullText: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  rawContentBlocks?: unknown[];
  msgSerial?: string;
}

export interface Activities {
  publishUserMessage(sessionId: string, message: string, customerName: string, messageId: string): Promise<void>;
  publishAgentMessage(sessionId: string, message: string, messageId: string): Promise<void>;
  callLLMStreaming(sessionId: string, messages: Message[], turnIndex: number): Promise<LLMResult>;
  executeToolCall(sessionId: string, toolName: string, toolInput: Record<string, unknown>): Promise<unknown>;
  publishEscalation(sessionId: string, reason: string): Promise<void>;
  notifyHumanAgent(
    sessionId: string,
    context: { customerName: string; reason: string; history: Message[] }
  ): Promise<string>;
  updateEscalationStatus(
    escalationSerial: string,
    status: 'responding' | 'resolved' | 'dismissed',
    sessionId: string
  ): Promise<void>;
  cleanupSessionClient(sessionId: string): Promise<void>;
}

/**
 * Publish a user message to the Ably session channel on behalf of the customer.
 * Uses REST with a deterministic message ID for idempotent publishing (safe on retry).
 * Sets clientId on the message so subscribers can attribute it to the user.
 */
export async function publishUserMessage(
  sessionId: string,
  message: string,
  customerName: string,
  messageId: string
): Promise<void> {
  const rest = getRestClient();
  const channel = rest.channels.get(channelName(sessionId));
  await channel.publish({ id: messageId, name: 'user', data: message, clientId: customerName });
}

/**
 * Publish a human agent's message to the session channel.
 * Uses name 'response' so the frontend renders it as an assistant/agent bubble.
 */
export async function publishAgentMessage(
  sessionId: string,
  message: string,
  messageId: string
): Promise<void> {
  const rest = getRestClient();
  const channel = rest.channels.get(channelName(sessionId));
  await channel.publish({
    id: messageId,
    name: 'response',
    data: message,
    extras: { headers: { status: 'complete', source: 'human-agent' } },
  });
}

/**
 * Stream LLM response tokens to Ably using the message-per-response pattern.
 *
 * Attempt-aware publishing (Decision 10):
 * - Attempt 1: Realtime publish (fast path, no idempotency overhead)
 * - Attempt 2+: REST publish with deterministic message ID. If the message
 *   already exists (dedup), the publish is a no-op — the original message
 *   with its partial appends is untouched. updateMessage({ data: '' })
 *   clears any partial content so we can stream fresh.
 *
 * Dedup window: documented as ~2 minutes from original publish, but tested
 * to confirm that appends/updates extend it. Since we constantly append
 * tokens during streaming, the window stays open for the stream's lifetime.
 */
export async function callLLMStreaming(
  sessionId: string,
  messages: Message[],
  turnIndex: number
): Promise<LLMResult> {
  const attempt = Context.current().info.attempt;
  const realtime = getRealtimeClient();
  const rest = getRestClient();
  const realtimeChannel = realtime.channels.get(channelName(sessionId));
  const restChannel = rest.channels.get(channelName(sessionId));

  // SIMPLIFICATION OPPORTUNITY: Presence is connection+clientId scoped, so durable
  // execution steps must re-enter presence. The SDK should support multiple presence
  // identities on a single connection.
  //
  // Enter presence using the per-session client so the frontend sees the agent as active.
  // This ensures enter/leave happen on the same connection even across Temporal retries.
  const sessionClient = getSessionRealtimeClient(sessionId);
  const presenceChannel = sessionClient.channels.get(channelName(sessionId));
  await presenceChannel.presence.enter({ status: 'processing' });

  const messageId = `msg_${sessionId}_turn${turnIndex}`;
  let msgSerial: string;

  if (attempt === 1) {
    // FAST PATH: Realtime publish, no idempotency overhead
    const result = await realtimeChannel.publish({ name: 'response', data: '' });
    const serial = result.serials[0];
    if (!serial) throw new Error('Failed to get serial from Realtime publish');
    msgSerial = serial;
  } else {
    // RECOVERY PATH: REST publish with deterministic ID = idempotent create-if-not-exists.
    // On attempt 2: creates a new message (attempt 1 used Realtime with no ID).
    //   The updateMessage below is a harmless no-op (message is already empty).
    // On attempt 3+: deduped (same ID as attempt 2), returns the existing message's
    //   serial. That message may have partial appends from the crashed prior attempt.
    //   The updateMessage resets its body so we can stream fresh.
    const result = await restChannel.publish({ id: messageId, name: 'response', data: '' });
    const serial = result.serials[0];
    if (!serial) throw new Error('Failed to get serial from REST idempotent publish');
    msgSerial = serial;
    await realtimeChannel.updateMessage({ serial: msgSerial, data: '' });
  }

  // Subscribe to control messages for live steering (stop/steer)
  // Also connect Temporal's cancellation signal so scope.cancel() aborts the stream.
  const abortController = new AbortController();
  const controlHandler = () => {
    abortController.abort();
  };
  const temporalCancelSignal = Context.current().cancellationSignal;
  const onTemporalCancel = () => abortController.abort();
  if (temporalCancelSignal.aborted) {
    abortController.abort();
  } else {
    temporalCancelSignal.addEventListener('abort', onTemporalCancel);
  }
  await realtimeChannel.subscribe('control', controlHandler);

  // Stream Claude response, appending each token to Ably
  const appendPromises: Promise<unknown>[] = [];
  let fullText = '';

  let llmResult;
  try {
    llmResult = await streamClaude(messages, {
      onToken: (text) => {
        fullText += text;
        // Don't await — pipeline appends for throughput (per Ably docs)
        appendPromises.push(realtimeChannel.appendMessage({ serial: msgSerial, data: text }));
      },
      heartbeat: () => Context.current().heartbeat(),
      abortSignal: abortController.signal,
    });
  } finally {
    realtimeChannel.unsubscribe('control', controlHandler);
    temporalCancelSignal.removeEventListener('abort', onTemporalCancel);
  }

  // Check if streaming was aborted (by control message or Temporal cancellation)
  const aborted = abortController.signal.aborted;

  // NOTE: The cleanup below (settling appends + writing terminal status) runs after
  // the stream has already stopped but before we rethrow CancelledFailure. If the
  // worker crashes between here and the throw, the retry will start a fresh Ably
  // message (attempt 2, idempotent) and re-stream. The old message would be left
  // without a terminal status header. This is acceptable: presence leave (fired
  // automatically by Ably on disconnect) clears the frontend's "thinking" state,
  // and the retry produces a correct replacement message.

  // Wait for all appends; fall back to full updateMessage if any failed
  const results = await Promise.allSettled(appendPromises);
  const anyFailed = results.some((r) => r.status === 'rejected');

  if (anyFailed) {
    await realtimeChannel.updateMessage({ serial: msgSerial, data: fullText });
  }

  // Signal terminal status — 'stopped' if aborted, 'complete' otherwise.
  // This header is the source of truth for session state (what the user sees).
  const terminalStatus = aborted ? 'stopped' : 'complete';
  await realtimeChannel.updateMessage({
    serial: msgSerial,
    extras: { headers: { status: terminalStatus } },
  });

  // If aborted by cancellation, leave presence and rethrow
  if (aborted) {
    await presenceChannel.presence.leave();
    throw new CancelledFailure('LLM streaming aborted');
  }

  // Leave presence with handing-over status — more steps may follow (tool calls, follow-up LLM).
  // The client determines terminal state from the message completion signal.
  await presenceChannel.presence.leave({ status: 'handing-over' });

  return {
    type: llmResult.type,
    fullText: llmResult.fullText,
    toolName: llmResult.toolName,
    toolInput: llmResult.toolInput,
    toolUseId: llmResult.toolUseId,
    rawContentBlocks: llmResult.rawContentBlocks,
    msgSerial,
  };
}

/**
 * Execute a tool call and publish status to the session channel.
 * Publishes a 'tool' message with loading state, then updates with result.
 */
export async function executeToolCall(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<unknown> {
  const realtime = getRealtimeClient();
  const channel = realtime.channels.get(channelName(sessionId));

  // Enter presence using the per-session client
  const sessionClient = getSessionRealtimeClient(sessionId);
  const presenceChannel = sessionClient.channels.get(channelName(sessionId));
  await presenceChannel.presence.enter({ status: 'processing' });

  // Subscribe to control messages for live steering (stop/steer) — same pattern as callLLMStreaming
  const abortController = new AbortController();
  const controlHandler = () => {
    abortController.abort();
  };
  await channel.subscribe('control', controlHandler);

  // Publish tool call start
  const result = await channel.publish({
    name: 'tool',
    data: JSON.stringify({ toolName, input: toolInput, status: 'calling' }),
  });
  const serial = result.serials[0];

  let toolResult: unknown;

  try {
    switch (toolName) {
      case 'lookupOrder':
        toolResult = {
          orderId: toolInput.orderId,
          status: 'shipped',
          trackingNumber: 'TRK-12345-MOCK',
          estimatedDelivery: '2026-03-10',
        };
        break;
      case 'checkRefundStatus':
        toolResult = { refundId: toolInput.refundId, status: 'processing', estimatedCompletion: '3-5 business days' };
        break;
      case 'getAccountDetails':
        toolResult = { customerId: toolInput.customerId, name: 'Jane Doe', plan: 'Pro', memberSince: '2024-01' };
        break;
      case 'doResearch': {
        // Long-running mock research — ~20 seconds with progress updates
        const steps = [
          { label: 'Searching knowledge base...', durationMs: 4000 },
          { label: 'Analyzing order history...', durationMs: 4000 },
          { label: 'Cross-referencing support tickets...', durationMs: 4000 },
          { label: 'Checking product documentation...', durationMs: 4000 },
          { label: 'Compiling findings...', durationMs: 4000 },
        ];
        const topic = toolInput.topic as string;

        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          // Update tool message with current progress
          if (serial) {
            await channel.updateMessage({
              serial,
              data: JSON.stringify({
                toolName, input: toolInput, status: 'calling',
                progress: { step: i + 1, total: steps.length, label: step.label },
              }),
            });
          }
          Context.current().heartbeat(`step ${i + 1}`);
          // Cancellation-aware sleep — responds to both Temporal cancellation and Ably control messages
          await cancellableSleep(step.durationMs, abortController.signal);
        }

        toolResult = {
          topic,
          findings: [
            'Found 3 related support tickets from other customers',
            'Product documentation confirms this is a known limitation',
            'Engineering team has a fix scheduled for next release (v2.4)',
            'Workaround available: clear browser cache and retry',
          ],
          recommendation: 'Apply the workaround now, permanent fix coming in v2.4.',
        };
        break;
      }
      default:
        toolResult = { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    channel.unsubscribe('control', controlHandler);
    // On cancellation: update the tool message to show 'cancelled', leave presence, then rethrow
    // so the workflow's CancellationScope handles agent state rollback.
    if (err instanceof CancelledFailure) {
      if (serial) {
        await channel.updateMessage({
          serial,
          data: JSON.stringify({
            toolName, input: toolInput,
            status: 'cancelled',
          }),
        });
      }
      await presenceChannel.presence.leave();
      throw err;
    }
    throw err;
  }

  channel.unsubscribe('control', controlHandler);

  // Publish tool result — update the same message with result data
  if (serial) {
    await channel.updateMessage({
      serial,
      data: JSON.stringify({
        toolName, input: toolInput,
        status: 'complete',
        result: toolResult,
      }),
    });
  }

  // Leave presence with handing-over status — a follow-up LLM call typically follows.
  await presenceChannel.presence.leave({ status: 'handing-over' });

  return toolResult;
}

/**
 * Publish an escalation notice to the session channel so the customer sees it.
 */
export async function publishEscalation(
  sessionId: string,
  reason: string
): Promise<void> {
  const rest = getRestClient();
  const channel = rest.channels.get(channelName(sessionId));
  await channel.publish({ name: 'escalation', data: reason });
}

export async function notifyHumanAgent(
  sessionId: string,
  context: { customerName: string; reason: string; history: Message[] }
): Promise<string> {
  const realtime = getRealtimeClient();
  const channel = realtime.channels.get('ai:agent:escalations');
  const result = await channel.publish({
    name: 'escalation',
    data: JSON.stringify({
      sessionId,
      customerName: context.customerName,
      reason: context.reason,
      messageCount: context.history.length,
      status: 'pending',
    }),
  });
  const serial = result.serials[0];
  if (!serial) throw new Error('Failed to get serial from escalation publish');
  return serial;
}

/**
 * Update the status of an escalation message on the agent dashboard channel.
 * Uses Ably mutable messages — updateMessage preserves the original message
 * but replaces its data with the new status.
 */
export async function updateEscalationStatus(
  escalationSerial: string,
  status: 'responding' | 'resolved' | 'dismissed',
  sessionId: string
): Promise<void> {
  const realtime = getRealtimeClient();
  const channel = realtime.channels.get('ai:agent:escalations');
  await channel.updateMessage({
    serial: escalationSerial,
    data: JSON.stringify({ status, sessionId }),
  });
}

/**
 * Clean up the per-session Ably client when the workflow completes.
 * This closes the connection, which triggers an automatic presence leave.
 */
export async function cleanupSessionClient(sessionId: string): Promise<void> {
  closeSessionClient(sessionId);
}
