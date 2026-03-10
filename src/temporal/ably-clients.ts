import Ably from 'ably';

function getApiKey(): string {
  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) throw new Error('ABLY_API_KEY environment variable is required');
  return apiKey;
}

let realtimeClient: Ably.Realtime | null = null;
let restClient: Ably.Rest | null = null;

// Realtime client without a fixed clientId — we use a privileged (API key)
// connection so clientId can be set per-message on REST publishes. For Realtime
// publishes (agent responses), messages are identified by name ('response').
// Presence clientId will be addressed in Milestone 9.
export function getRealtimeClient(): Ably.Realtime {
  if (!realtimeClient) {
    realtimeClient = new Ably.Realtime({ key: getApiKey(), echoMessages: false, clientId: 'ai-agent' });
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

export function channelName(sessionId: string): string {
  return `ai:support:${sessionId}`;
}
