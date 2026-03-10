import { NextRequest, NextResponse } from 'next/server';
import { getTemporalClient } from '@/lib/temporal-client';
import Ably from 'ably';

/**
 * Steer or stop the AI generation mid-stream.
 * Dual delivery: ephemeral Ably message for instant pickup + Temporal signal as durable safety net.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;
  const body = await request.json();
  const { action, text, messageId } = body;

  if (!action || !['stop', 'newMessage'].includes(action)) {
    return NextResponse.json({ error: 'action must be "stop" or "newMessage"' }, { status: 400 });
  }

  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'ABLY_API_KEY not configured' }, { status: 500 });
  }

  // 1. Ephemeral Ably message — instant delivery to the running activity (~50ms).
  // Marked ephemeral so it's excluded from history, rewind, and reconnect resume.
  // Only the currently-connected activity receives it — which is exactly what we want,
  // since the Temporal signal (below) is the durable safety net.
  const rest = new Ably.Rest({ key: apiKey });
  const channel = rest.channels.get(`ai:support:${sessionId}`);
  await channel.publish({ name: 'control', data: JSON.stringify({ action, text }), extras: { ephemeral: true } });

  // 2. Temporal signal — durable safety net. Even if the activity didn't receive
  //    the Ably message, the workflow will process this on the next loop iteration.
  const workflowId = `support-${sessionId}`;
  const client = await getTemporalClient();
  try {
    const handle = client.workflow.getHandle(workflowId);
    await handle.signal('steerGeneration', { action, text, messageId });
  } catch (err) {
    // Workflow may have already completed — not an error for stop commands
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`Steer signal failed (workflow may be done): ${msg}`);
  }

  return NextResponse.json({ ok: true });
}
