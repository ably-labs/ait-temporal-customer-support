import {
  proxyActivities, setHandler, defineSignal,
} from '@temporalio/workflow';
import type { OneShotActivities } from './one-shot-activities';
import type { Message } from './workflows';

export const stopOneShot = defineSignal('stopOneShot');

const activities = proxyActivities<OneShotActivities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

/**
 * One-shot workflow for double-text handling.
 * Processes a user's parallel request independently of the primary workflow:
 *   1. Stream LLM response locally (accumulate in memory)
 *   2. Wait for predecessor task to finish delivering
 *   3. Deliver accumulated response to Ably channel
 *   4. Merge conversation context back into the primary workflow
 */
export async function oneShotWorkflow(
  sessionId: string,
  taskId: string,
  predecessorTaskId: string,
  userMessage: string,
  _messageId?: string,
): Promise<void> {
  let stopped = false;
  setHandler(stopOneShot, () => { stopped = true; });

  const messages: Message[] = [{ role: 'user', content: userMessage }];

  // Step 1: Process LLM locally
  const { accumulatedText, cancelled } = await activities.processLLMLocally(
    sessionId, taskId, messages
  );

  if (cancelled || stopped) return;

  // Step 2: Wait for predecessor
  const waitResult = await activities.waitForPredecessor(
    sessionId, taskId, predecessorTaskId
  );

  if (waitResult === 'stopped' || stopped) return;

  // Step 3: Deliver accumulated response
  await activities.deliverAccumulated(sessionId, taskId, accumulatedText);

  // Step 4: Merge context back
  const mergeMessages: Message[] = [
    { role: 'user', content: userMessage },
    { role: 'assistant', content: accumulatedText },
  ];
  await activities.mergeContextBack(sessionId, mergeMessages);
}
