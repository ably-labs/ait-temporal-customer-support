import { NextRequest, NextResponse } from 'next/server';
import { getTemporalClient, TASK_QUEUE } from '@/lib/temporal-client';
import { classifyIntent } from '@/lib/classify-intent';
import Ably from 'ably';

/**
 * Steer, stop, or double-text the AI generation mid-stream.
 *
 * For 'stop': ephemeral Ably control + Temporal signal.
 *
 * For 'newMessage': classifies intent, then:
 * - 'steer': abort via control + Temporal signal (workflow publishes user message)
 * - 'double-text': start independent one-shot workflow
 * - 'stop': same as explicit stop
 *
 * User message is NOT published to Ably here — the Temporal workflow's
 * publishUserMessage activity handles that (with idempotent message ID
 * matching the optimistic UI entry).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;
  const body = await request.json();
  const { action, text, messageId, currentTaskSummary } = body;

  if (!action || !['stop', 'newMessage'].includes(action)) {
    return NextResponse.json({ error: 'action must be "stop" or "newMessage"' }, { status: 400 });
  }

  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'ABLY_API_KEY not configured' }, { status: 500 });
  }

  const rest = new Ably.Rest({ key: apiKey });
  const channel = rest.channels.get(`ai:support:${sessionId}`);

  if (action === 'stop') {
    await channel.publish({ name: 'control', data: JSON.stringify({ action: 'stop' }), extras: { ephemeral: true } });
    const client = await getTemporalClient();
    try {
      const handle = client.workflow.getHandle(`support-${sessionId}`);
      await handle.signal('steerGeneration', { action: 'stop' });
    } catch (err) {
      console.warn(`Steer signal failed: ${err instanceof Error ? err.message : 'Unknown'}`);
    }
    return NextResponse.json({ ok: true });
  }

  // action === 'newMessage'
  if (!text || !messageId) {
    return NextResponse.json({ error: 'text and messageId required for newMessage' }, { status: 400 });
  }

  // Classify: is this a redirect (steer), independent request (double-text), or stop?
  const intent = await classifyIntent(text, currentTaskSummary ?? '');

  if (intent === 'double-text') {
    // Publish user message to Ably (one-shot workflow won't do this)
    await channel.publish({ id: messageId, name: 'user', data: text });

    const taskId = `dt_${Date.now()}`;
    const client = await getTemporalClient();
    await client.workflow.start('oneShotWorkflow', {
      taskQueue: TASK_QUEUE,
      workflowId: `oneshot-${sessionId}-${taskId}`,
      args: [sessionId, taskId, text],
    });
    return NextResponse.json({ ok: true, intent: 'double-text', taskId });
  }

  // For 'steer' or 'stop': abort current step + signal workflow
  const controlAction = intent === 'stop' ? 'stop' : 'newMessage';
  await channel.publish({
    name: 'control',
    data: JSON.stringify({ action: controlAction, text }),
    extras: { ephemeral: true },
  });

  const client = await getTemporalClient();
  try {
    const handle = client.workflow.getHandle(`support-${sessionId}`);
    await handle.signal('steerGeneration', { action: controlAction, text, messageId });
  } catch (err) {
    console.warn(`Steer signal failed: ${err instanceof Error ? err.message : 'Unknown'}`);
  }

  return NextResponse.json({ ok: true, intent });
}
