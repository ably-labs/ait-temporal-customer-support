import { NextRequest, NextResponse } from 'next/server';
import { getTemporalClient, TASK_QUEUE } from '@/lib/temporal-client';
import Ably from 'ably';
import { classifyIntent } from '@/lib/classify-intent';

/**
 * Track the last active task per session for predecessor chaining.
 * In-memory — acceptable for a demo. Production would use a durable store.
 */
const lastActiveTaskId = new Map<string, string>();

function getLastTaskId(sessionId: string): string {
  return lastActiveTaskId.get(sessionId) ?? 'primary';
}

/**
 * Steer, stop, or double-text the AI generation mid-stream.
 *
 * For 'stop': Ably control + Temporal signal (existing behavior).
 * For 'newMessage': publish user msg, classify intent, then route:
 *   - 'steer': cancel current + restart with new message (existing behavior)
 *   - 'double-text': ack + start one-shot Temporal workflow in parallel
 *   - 'stop': cancel current generation
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
    // Ephemeral Ably message for instant pickup + Temporal signal as durable safety net
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

  // Publish user message immediately
  await channel.publish({ id: messageId, name: 'user', data: text });

  // Classify intent synchronously
  const intent = await classifyIntent(text, currentTaskSummary ?? '');

  switch (intent) {
    case 'steer': {
      // Cancel current generation and restart with new message
      await channel.publish({ name: 'control', data: JSON.stringify({ action: 'newMessage', text }), extras: { ephemeral: true } });
      const client = await getTemporalClient();
      try {
        const handle = client.workflow.getHandle(`support-${sessionId}`);
        await handle.signal('steerGeneration', { action: 'newMessage', text, messageId });
      } catch (err) {
        console.warn(`Steer signal failed: ${err instanceof Error ? err.message : 'Unknown'}`);
      }
      break;
    }

    case 'double-text': {
      // Start a parallel one-shot workflow
      const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const predecessorTaskId = getLastTaskId(sessionId);
      lastActiveTaskId.set(sessionId, taskId);

      // Acknowledge to the user
      await channel.publish({
        name: 'response',
        data: `Got it \u2014 I'll handle "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}" in parallel while I finish up the current task.`,
        extras: { headers: { status: 'complete', source: 'system-ack', taskId } },
      });

      const client = await getTemporalClient();
      await client.workflow.start('oneShotWorkflow', {
        args: [sessionId, taskId, predecessorTaskId, text, messageId],
        taskQueue: TASK_QUEUE,
        workflowId: `oneshot-${sessionId}-${taskId}`,
      });
      break;
    }

    case 'stop': {
      await channel.publish({ name: 'control', data: JSON.stringify({ action: 'stop' }), extras: { ephemeral: true } });
      const client = await getTemporalClient();
      try {
        const handle = client.workflow.getHandle(`support-${sessionId}`);
        await handle.signal('steerGeneration', { action: 'stop' });
      } catch (err) {
        console.warn(`Steer signal failed: ${err instanceof Error ? err.message : 'Unknown'}`);
      }
      break;
    }
  }

  return NextResponse.json({ ok: true });
}
