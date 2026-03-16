import { NextRequest, NextResponse } from 'next/server';
import { getTemporalClient, TASK_QUEUE } from '@/lib/temporal-client';
import { classifyIntent } from '@/lib/classify-intent';
import Ably from 'ably';

/**
 * Steer or stop the AI generation mid-stream.
 * Dual delivery: ephemeral Ably message for instant pickup + Temporal signal as durable safety net.
 * For double-text: starts a parallel one-shot workflow instead of interrupting the current one.
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
    // Stop: ephemeral Ably control + Temporal signal
    await channel.publish({ name: 'control', data: JSON.stringify({ action, text }), extras: { ephemeral: true } });

    const workflowId = `support-${sessionId}`;
    const client = await getTemporalClient();
    try {
      const handle = client.workflow.getHandle(workflowId);
      await handle.signal('steerGeneration', { action, text, messageId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.warn(`Steer signal failed (workflow may be done): ${msg}`);
    }

    return NextResponse.json({ ok: true });
  }

  // action === 'newMessage'
  // Publish the user message to Ably so it appears in chat immediately
  await channel.publish({ name: 'user', data: text, clientId: `customer-${sessionId}` });

  // Classify intent to decide: steer, double-text, or stop
  const intent = await classifyIntent(text, currentTaskSummary || '');

  if (intent === 'double-text') {
    // Start a parallel one-shot workflow — don't interrupt the main workflow
    const taskId = `dt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const client = await getTemporalClient();
    await client.workflow.start('oneShotWorkflow', {
      taskQueue: TASK_QUEUE,
      workflowId: `oneshot-${sessionId}-${taskId}`,
      args: [sessionId, taskId, text],
    });

    return NextResponse.json({ ok: true, intent: 'double-text', taskId });
  }

  if (intent === 'stop') {
    // Classified as stop — same as explicit stop action
    await channel.publish({ name: 'control', data: JSON.stringify({ action: 'stop', text }), extras: { ephemeral: true } });

    const workflowId = `support-${sessionId}`;
    const client = await getTemporalClient();
    try {
      const handle = client.workflow.getHandle(workflowId);
      await handle.signal('steerGeneration', { action: 'stop', text, messageId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.warn(`Steer signal failed (workflow may be done): ${msg}`);
    }

    return NextResponse.json({ ok: true, intent: 'stop' });
  }

  // intent === 'steer' — interrupt current generation with the new message
  await channel.publish({ name: 'control', data: JSON.stringify({ action, text }), extras: { ephemeral: true } });

  const workflowId = `support-${sessionId}`;
  const client = await getTemporalClient();
  try {
    const handle = client.workflow.getHandle(workflowId);
    await handle.signal('steerGeneration', { action, text, messageId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`Steer signal failed (workflow may be done): ${msg}`);
  }

  return NextResponse.json({ ok: true, intent: 'steer' });
}
