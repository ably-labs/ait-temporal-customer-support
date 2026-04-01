import Ably from 'ably';

function getApiKey(): string {
  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) throw new Error('ABLY_API_KEY environment variable is required');
  return apiKey;
}

let realtimeClient: Ably.Realtime | null = null;
let restClient: Ably.Rest | null = null;

// Shared Realtime client for non-presence operations (publishing, subscribing).
// No clientId — uses privileged (API key) connection so clientId can be set
// per-message on REST publishes. For Realtime publishes (agent responses),
// messages are identified by name ('response').
export function getRealtimeClient(): Ably.Realtime {
  if (!realtimeClient) {
    // Prevents the agent from receiving its own messages. Future AI Transport SDK
    // versions may handle this automatically for agent connections.
    realtimeClient = new Ably.Realtime({ key: getApiKey(), echoMessages: false });
  }
  return realtimeClient;
}

export function getRestClient(): Ably.Rest {
  if (!restClient) {
    restClient = new Ably.Rest({ key: getApiKey() });
  }
  return restClient;
}

export function closeRealtimeClient(): void {
  if (realtimeClient) {
    realtimeClient.close();
    realtimeClient = null;
  }
}

// Per-session Realtime clients for presence.
// Each activity creates and closes its own Realtime client with
// clientId: 'ai-agent:<sessionId>' so that presence is scoped per-session.
// There is no cross-activity caching because Temporal activities have no worker
// affinity — sequential activities from the same workflow can land on different
// worker processes, making a Map-based cache a leak vector.
//
// SIMPLIFICATION OPPORTUNITY: Each activity creates and closes its own Realtime
// client (~100-300ms connection overhead per activity). The SDK should provide
// connection pooling with identity isolation — one pooled connection, multiple
// independent clientIds with their own presence and message identity.

// Track active session clients so we can close them on worker shutdown
// (ensures presence leave events fire immediately instead of waiting for TCP timeout).
const activeSessionClients = new Set<Ably.Realtime>();

export function createSessionRealtimeClient(sessionId: string, taskId?: string): Ably.Realtime {
  const client = new Ably.Realtime({
    key: getApiKey(),
    // Prevents the agent from receiving its own messages. Future AI Transport SDK
    // versions may handle this automatically for agent connections.
    echoMessages: false,
    clientId: taskId ? `ai-agent:${sessionId}:${taskId}` : `ai-agent:${sessionId}`,
  });
  activeSessionClients.add(client);
  return client;
}

export function untrackSessionClient(client: Ably.Realtime): void {
  activeSessionClients.delete(client);
}

export function closeAllSessionClients(): void {
  for (const client of activeSessionClients) {
    client.close();
  }
  activeSessionClients.clear();
}

export function channelName(sessionId: string): string {
  return `ai:support:${sessionId}`;
}

/**
 * Close a per-activity session client safely during a presence handover.
 *
 * After an activity calls `presence.leave({ status: 'handing-over' })`, the
 * next activity will create a new session client and enter presence. If we
 * close immediately, the connection drop fires a bare presence leave that
 * arrives at the frontend *before* the next activity has entered — causing a
 * brief "agent disconnected" flicker.
 *
 * This helper keeps the connection alive until one of:
 *   a) A new presence enter is detected for an ai-agent:* member → close immediately
 *   b) The timeout (default 15s) elapses → close anyway
 *
 * By waiting, the bare leave from close() either never matters (case a: the
 * new activity is already present) or happens well after the frontend's own
 * handover timeout has handled the gap (case b).
 */
export async function closeAfterHandover(
  sessionClient: Ably.Realtime,
  channel: string,
  timeoutMs = 15_000,
): Promise<void> {
  const presenceChannel = sessionClient.channels.get(channel);

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      presenceChannel.presence.unsubscribe(onPresenceEvent);
      resolve();
    }, timeoutMs);

    const onPresenceEvent = (member: Ably.PresenceMessage) => {
      // A new activity entered presence — handover succeeded, safe to close
      if (member.action === 'enter' && member.clientId?.startsWith('ai-agent:')) {
        clearTimeout(timer);
        presenceChannel.presence.unsubscribe(onPresenceEvent);
        resolve();
      }
    };

    presenceChannel.presence.subscribe(onPresenceEvent);
  });

  activeSessionClients.delete(sessionClient);
  sessionClient.close();
}
