import { proxyActivities } from '@temporalio/workflow';
import type { Activities } from './activities';
import type { Message } from './workflows';

const activities = proxyActivities<Activities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

export async function oneShotWorkflow(
  sessionId: string,
  taskId: string,
  userMessage: string,
): Promise<void> {
  const messages: Message[] = [{ role: 'user', content: userMessage }];

  const llmResult = await activities.callLLMStreaming(sessionId, messages, 0, taskId);

  if (llmResult.type === 'tool_use' && llmResult.toolName && llmResult.toolInput) {
    messages.push({
      role: 'assistant',
      content: llmResult.fullText,
      rawContentBlocks: llmResult.rawContentBlocks,
    });

    const toolResult = await activities.executeToolCall(
      sessionId, llmResult.toolName, llmResult.toolInput, taskId
    );

    messages.push({
      role: 'tool',
      content: JSON.stringify(toolResult),
      toolName: llmResult.toolName,
      toolUseId: llmResult.toolUseId,
    });

    await activities.callLLMStreaming(sessionId, messages, 1, taskId);
  }
}
