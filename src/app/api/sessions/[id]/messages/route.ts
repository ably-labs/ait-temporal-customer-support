import { NextRequest, NextResponse } from 'next/server';
import { getTemporalClient } from '@/lib/temporal-client';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;
  const body = await request.json();
  const message = body.message;
  const messageId = body.messageId;

  if (!message || typeof message !== 'string') {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }
  if (!messageId || typeof messageId !== 'string') {
    return NextResponse.json({ error: 'messageId is required' }, { status: 400 });
  }

  const workflowId = `support-${sessionId}`;
  const client = await getTemporalClient();

  try {
    const handle = client.workflow.getHandle(workflowId);
    await handle.signal('userMessage', message, messageId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to signal workflow: ${message}` }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
