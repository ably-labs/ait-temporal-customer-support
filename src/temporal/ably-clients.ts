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
// Each session gets its own connection with clientId: 'ai-agent:<sessionId>'
// so that presence is scoped per-session and works correctly across multiple
// Temporal workers. Cached by sessionId so the same session reuses the same
// client within a worker.
//
// Design choice: We use a Map rather than per-activity client creation because
// multiple activities within the same session (callLLMStreaming, executeToolCall)
// need the same connection for presence continuity. The Map ensures the same
// clientId reuses the same connection within a worker. Cleanup happens when the
// workflow completes (cleanupSessionClient activity) or on worker shutdown.
//
// SIMPLIFICATION OPPORTUNITY: Each agent session needs its own Realtime client
// for streaming, subscribing, and presence. The SDK should provide connection
// pooling with identity isolation — one pooled connection, multiple independent
// clientIds with their own presence and message identity.
const sessionClients = new Map<string, Ably.Realtime>();

export function getSessionRealtimeClient(sessionId: string): Ably.Realtime {
  let client = sessionClients.get(sessionId);
  if (!client) {
    client = new Ably.Realtime({
      key: getApiKey(),
      // Prevents the agent from receiving its own messages. Future AI Transport SDK
      // versions may handle this automatically for agent connections.
      echoMessages: false,
      clientId: `ai-agent:${sessionId}`,
    });
    sessionClients.set(sessionId, client);
  }
  return client;
}

export function closeSessionClient(sessionId: string): void {
  const client = sessionClients.get(sessionId);
  if (client) {
    client.close();
    sessionClients.delete(sessionId);
  }
}

export function channelName(sessionId: string): string {
  return `ai:support:${sessionId}`;
}
