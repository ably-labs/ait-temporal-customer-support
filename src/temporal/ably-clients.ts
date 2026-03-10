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
const sessionClients = new Map<string, Ably.Realtime>();

export function getSessionRealtimeClient(sessionId: string): Ably.Realtime {
  let client = sessionClients.get(sessionId);
  if (!client) {
    client = new Ably.Realtime({
      key: getApiKey(),
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
