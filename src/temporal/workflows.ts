import { proxyActivities, setHandler, condition, defineSignal } from '@temporalio/workflow';
import type { Activities } from './activities';

// Signal definitions
export const userMessage = defineSignal<[string]>('userMessage');
export const humanAgentResponse = defineSignal<[{ action: string; message?: string }]>('humanAgentResponse');


export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolName?: string;
}

const activities = proxyActivities<Activities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    maximumAttempts: 3,
  },
});

export async function supportSessionWorkflow(
  sessionId: string,
  customerName: string
): Promise<void> {
  const messages: Message[] = [];
  let pendingUserMessage: string | null = null;
  let status: 'active' | 'escalated' | 'resolved' = 'active';
  let humanDecision: { action: string; message?: string } | null = null;

  // Signal handlers
  setHandler(userMessage, (msg: string) => {
    pendingUserMessage = msg;
  });

  setHandler(humanAgentResponse, (decision) => {
    humanDecision = decision;
  });


  let turnIndex = 0;

  while (status !== 'resolved') {
    // Durable wait — zero compute, survives crashes
    await condition(() => pendingUserMessage !== null);

    const userMsg = pendingUserMessage!;
    pendingUserMessage = null;

    messages.push({ role: 'user', content: userMsg });

    // Publish user message to Ably channel on behalf of the customer
    await activities.publishUserMessage(sessionId, userMsg, customerName);

    // Call LLM (streaming tokens to Ably inside the activity)
    const llmResult = await activities.callLLMStreaming(sessionId, messages, turnIndex);
    turnIndex++;

    messages.push({ role: 'assistant', content: llmResult.fullText });

    if (llmResult.type === 'tool_use') {
      const toolResult = await activities.executeToolCall(
        llmResult.toolName!,
        llmResult.toolInput!
      );
      messages.push({ role: 'tool', content: JSON.stringify(toolResult), toolName: llmResult.toolName });

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
