import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { closeAfterHandover } from '../temporal/ably-clients';

// Minimal mock for Ably.PresenceMessage
type MockPresenceMessage = { action: string; clientId: string };

// Build a mock sessionClient with controllable presence subscription
function createMockSessionClient() {
  let presenceHandler: ((msg: MockPresenceMessage) => void) | null = null;

  const presenceChannel = {
    presence: {
      subscribe: vi.fn((handler: (msg: MockPresenceMessage) => void) => {
        presenceHandler = handler;
      }),
      unsubscribe: vi.fn((handler: unknown) => {
        if (presenceHandler === handler) presenceHandler = null;
      }),
    },
  };

  const channels = {
    get: vi.fn(() => presenceChannel),
  };

  const client = {
    channels,
    close: vi.fn(),
    auth: { clientId: 'ai-agent:test-session-self' },
  };

  return {
    client: client as unknown as import('ably').default.Realtime,
    presenceChannel,
    // Simulate a presence event arriving
    firePresence: (msg: MockPresenceMessage) => {
      presenceHandler?.(msg as any);
    },
  };
}

describe('closeAfterHandover', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('closes immediately when a new ai-agent enter event arrives', async () => {
    const { client, firePresence } = createMockSessionClient();

    const promise = closeAfterHandover(client, 'ai:support:test-session', 15_000);

    // Simulate next activity entering presence
    firePresence({ action: 'enter', clientId: 'ai-agent:test-session' });

    await promise;
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('closes after timeout when no enter event arrives', async () => {
    const { client } = createMockSessionClient();

    const promise = closeAfterHandover(client, 'ai:support:test-session', 5_000);

    // Advance past timeout
    vi.advanceTimersByTime(5_000);

    await promise;
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('ignores non-enter presence events', async () => {
    const { client, firePresence } = createMockSessionClient();

    const promise = closeAfterHandover(client, 'ai:support:test-session', 5_000);

    // Leave and update events should be ignored
    firePresence({ action: 'leave', clientId: 'ai-agent:test-session' });
    firePresence({ action: 'update', clientId: 'ai-agent:test-session' });

    // Still waiting — only timeout resolves
    vi.advanceTimersByTime(5_000);

    await promise;
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('ignores enter events from non-agent clients', async () => {
    const { client, firePresence } = createMockSessionClient();

    const promise = closeAfterHandover(client, 'ai:support:test-session', 5_000);

    // A user entering presence should not trigger close
    firePresence({ action: 'enter', clientId: 'user:123' });

    vi.advanceTimersByTime(5_000);

    await promise;
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes from presence on enter detection', async () => {
    const { client, presenceChannel, firePresence } = createMockSessionClient();

    const promise = closeAfterHandover(client, 'ai:support:test-session', 15_000);

    firePresence({ action: 'enter', clientId: 'ai-agent:test-session' });

    await promise;
    expect(presenceChannel.presence.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes from presence on timeout', async () => {
    const { client, presenceChannel } = createMockSessionClient();

    const promise = closeAfterHandover(client, 'ai:support:test-session', 5_000);

    vi.advanceTimersByTime(5_000);

    await promise;
    expect(presenceChannel.presence.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
