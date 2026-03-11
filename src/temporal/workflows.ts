import {
  proxyActivities, setHandler, condition, defineSignal,
  CancellationScope, isCancellation,
} from '@temporalio/workflow';
import type { Activities } from './activities';

// Signal definitions
export const userMessage = defineSignal<[string, string]>('userMessage');
export const humanAgentResponse = defineSignal<[{ action: string; message?: string }]>('humanAgentResponse');
export const steerGeneration = defineSignal<[{ action: 'stop' | 'newMessage'; text?: string; messageId?: string }]>('steerGeneration');


export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolName?: string;
  toolUseId?: string;
  // Raw Anthropic content blocks for assistant messages with tool_use
  // Needed so the follow-up API call includes the tool_use block
  rawContentBlocks?: unknown[];
}

const activities = proxyActivities<Activities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '30 seconds',
  retry: {
    maximumAttempts: 3,
  },
});

export async function supportSessionWorkflow(
  sessionId: string,
  customerName: string
): Promise<void> {
  const messages: Message[] = [];
  let pendingUserMessage: { text: string; messageId: string } | null = null;
  // Type-widened so TS doesn't incorrectly narrow after signal handler mutations.
  let status = 'active' as 'active' | 'escalated' | 'resolved';
  let humanDecision: { action: string; message?: string } | null = null;
  // Live steering: set by steerGeneration signal to cancel the running LLM scope
  let activeLLMScope: CancellationScope | null = null;
  let steerAction: { action: 'stop' | 'newMessage'; text?: string; messageId?: string } | null = null;

  // Signal handlers
  setHandler(userMessage, (msg: string, messageId: string) => {
    pendingUserMessage = { text: msg, messageId };
  });

  setHandler(humanAgentResponse, (decision) => {
    humanDecision = decision;
  });

  setHandler(steerGeneration, (steer) => {
    steerAction = steer;
    // Cancel the running LLM scope if one exists — activity will abort
    if (activeLLMScope) {
      activeLLMScope.cancel();
    }
  });

  let turnIndex = 0;

  try {
    while (status !== 'resolved') {
      // Durable wait — zero compute, survives crashes
      await condition(() => pendingUserMessage !== null);

      const { text: userMsg, messageId } = pendingUserMessage!;
      pendingUserMessage = null;

      messages.push({ role: 'user', content: userMsg });

      // Publish user message to Ably channel on behalf of the customer
      await activities.publishUserMessage(sessionId, userMsg, customerName, messageId);

      // If escalated, forward customer messages to the human agent — don't call AI
      if (status === 'escalated') {
        await activities.notifyHumanAgent(sessionId, {
          customerName,
          reason: `Customer sent a follow-up message: "${userMsg}"`,
          history: messages,
        });
        continue;
      }

      // Run the AI turn — may be cancelled by steerGeneration signal
      await runAITurn();
    }
  } finally {
    // No per-session client cleanup needed — each activity creates and closes
    // its own Realtime client in a finally block.
  }

  /**
   * Run one complete AI turn: LLM call, optional tool use + follow-up.
   * Wrapped in a CancellationScope so live steering can interrupt it.
   *
   * Cancellation strategy: checkpoint-based rollback.
   * Before calling the LLM, we snapshot `messages.length`. If the scope is
   * cancelled, we roll back agent state to the checkpoint — no ad-hoc message
   * inspection needed. Session state (what the user sees in Ably) is handled
   * independently by the activities: `callLLMStreaming` sends `status: 'stopped'`
   * and `executeToolCall` sends `status: 'cancelled'` before rethrowing.
   */
  async function runAITurn(): Promise<void> {
    // Checkpoint: snapshot agent state before this turn
    const checkpoint = messages.length;

    const scope = new CancellationScope();
    activeLLMScope = scope;

    try {
      await scope.run(async () => {
        // Call LLM (streaming tokens to Ably inside the activity)
        const llmResult = await activities.callLLMStreaming(sessionId, messages, turnIndex);
        turnIndex++;

        messages.push({
          role: 'assistant',
          content: llmResult.fullText,
          rawContentBlocks: llmResult.rawContentBlocks,
        });

        if (llmResult.type === 'tool_use') {
          const toolResult = await activities.executeToolCall(
            sessionId,
            llmResult.toolName!,
            llmResult.toolInput!
          );
          messages.push({
            role: 'tool',
            content: JSON.stringify(toolResult),
            toolName: llmResult.toolName,
            toolUseId: llmResult.toolUseId,
          });

          // Follow-up LLM call with tool results
          const followUp = await activities.callLLMStreaming(sessionId, messages, turnIndex);
          turnIndex++;
          messages.push({ role: 'assistant', content: followUp.fullText });
        } else if (llmResult.type === 'escalate') {
          await handleEscalation(llmResult);
        }
      });
    } catch (err) {
      if (isCancellation(err)) {
        // Roll back agent state to the checkpoint — clean and deterministic.
        // Session state (Ably messages) was already finalised by each activity
        // before rethrowing (status: 'stopped' / 'cancelled').
        messages.length = checkpoint;
      } else {
        throw err;
      }
    } finally {
      activeLLMScope = null;
    }

    // After cancellation, handle the steer action.
    if (steerAction) {
      const action = steerAction;
      steerAction = null;

      if (action.action === 'newMessage' && action.text && action.messageId) {
        pendingUserMessage = { text: action.text, messageId: action.messageId };
      } else {
        // 'stop' — notify the user via escalation notice
        await CancellationScope.nonCancellable(async () => {
          await activities.publishEscalation(
            sessionId,
            'Generation stopped. Send a new message when you\'re ready.'
          );
        });
      }
    }
  }

  async function handleEscalation(llmResult: {
    fullText: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
  }): Promise<void> {
    status = 'escalated';

    await activities.publishEscalation(
      sessionId,
      'Your request has been escalated to our support team. A human agent will be with you shortly.',
      'escalated'
    );

    const escalationSerial = await activities.notifyHumanAgent(sessionId, {
      customerName,
      reason: llmResult.toolInput?.reason as string || llmResult.fullText,
      history: messages,
    });

    let agentHasJoined = false;

    while (status === 'escalated') {
      await condition(() => humanDecision !== null || pendingUserMessage !== null);

      if (humanDecision !== null) {
        const decision = humanDecision as { action: string; message?: string };
        humanDecision = null;

        if (!agentHasJoined) {
          agentHasJoined = true;
          await activities.updateEscalationStatus(escalationSerial, 'responding', sessionId);
          await activities.publishEscalation(
            sessionId,
            'A support agent has joined the conversation. You can now communicate with them directly.'
          );
        }

        if (decision.message) {
          await activities.publishAgentMessage(
            sessionId,
            decision.message,
            `agent_${sessionId}_${turnIndex}`
          );
          turnIndex++;
          messages.push({ role: 'assistant', content: decision.message });
        }

        if (decision.action === 'resolve') {
          status = 'resolved';
          await activities.updateEscalationStatus(escalationSerial, 'resolved', sessionId);
          await activities.publishEscalation(
            sessionId,
            'This conversation has been resolved by our support team. Thank you for contacting us!',
            'resolved'
          );
        } else if (decision.action === 'handback') {
          status = 'active';
          await activities.publishEscalation(
            sessionId,
            'You have been reconnected to our AI assistant. How can we help you further?'
          );
        }
      }

      if (pendingUserMessage !== null) {
        const { text: msg, messageId: msgId } = pendingUserMessage;
        pendingUserMessage = null;
        messages.push({ role: 'user', content: msg });
        await activities.publishUserMessage(sessionId, msg, customerName, msgId);
      }
    }
  }
}
