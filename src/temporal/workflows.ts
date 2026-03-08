import { proxyActivities, setHandler, condition, defineSignal } from '@temporalio/workflow';
import type { Activities } from './activities';

// Signal definitions
export const userMessage = defineSignal<[string, string]>('userMessage');
export const humanAgentResponse = defineSignal<[{ action: string; message?: string }]>('humanAgentResponse');


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
  let status: 'active' | 'escalated' | 'resolved' = 'active';
  let humanDecision: { action: string; message?: string } | null = null;

  // Signal handlers
  setHandler(userMessage, (msg: string, messageId: string) => {
    pendingUserMessage = { text: msg, messageId };
  });

  setHandler(humanAgentResponse, (decision) => {
    humanDecision = decision;
  });


  let turnIndex = 0;

  while (status !== 'resolved') {
    // Durable wait — zero compute, survives crashes
    await condition(() => pendingUserMessage !== null);

    const { text: userMsg, messageId } = pendingUserMessage!;
    pendingUserMessage = null;

    messages.push({ role: 'user', content: userMsg });

    // Publish user message to Ably channel on behalf of the customer
    await activities.publishUserMessage(sessionId, userMsg, customerName, messageId);

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
      status = 'escalated';
      await activities.notifyHumanAgent(sessionId, {
        customerName,
        reason: llmResult.fullText,
        history: messages,
      });

      // Durable HITL wait — can last hours/days, zero compute
      await condition(() => humanDecision !== null);

      const decision = humanDecision as { action: string; message?: string } | null;
      if (decision?.action === 'resolve') {
        status = 'resolved';
      } else {
        status = 'active';
      }
      humanDecision = null;
    }
  }
}
