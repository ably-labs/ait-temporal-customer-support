import { NextRequest, NextResponse } from 'next/server';
import Ably from 'ably';

/**
 * Dismiss an escalation from the agent dashboard.
 * Updates the escalation message on Ably with status 'dismissed'.
 * This is a dashboard-only concern — not part of the conversation workflow.
 */
export async function POST(request: NextRequest) {
  const { serial, sessionId } = await request.json();

  if (!serial || !sessionId) {
    return NextResponse.json({ error: 'serial and sessionId are required' }, { status: 400 });
  }

  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'ABLY_API_KEY not configured' }, { status: 500 });
  }

  // SIMPLIFICATION OPPORTUNITY: updateMessage() requires a Realtime connection.
  // The SDK should expose this via the REST API so server-side code doesn't need
  // a WebSocket for a one-shot status update.
  const realtime = new Ably.Realtime({ key: apiKey });
  try {
    const channel = realtime.channels.get('ai:agent:escalations');
    await channel.updateMessage({
      serial,
      data: JSON.stringify({ status: 'dismissed', sessionId }),
    });
    return NextResponse.json({ ok: true });
  } finally {
    realtime.close();
  }
}
