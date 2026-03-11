'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { usePresenceListener } from 'ably/react';

/**
 * useAgentPresence — tracks AI agent presence on a session channel with
 * handover-aware logic.
 *
 * Per-session clientId format: 'ai-agent:<sessionId>'
 * Activities enter/leave presence independently, using { status: 'handing-over' }
 * on leave when more steps may follow. A 10-second timeout bridges the gap
 * between activities so the UI stays in "thinking" state during handovers.
 *
 * SIMPLIFICATION OPPORTUNITY: Presence is connection+clientId scoped, so durable
 * execution steps must re-enter presence. The SDK should support multiple presence
 * identities on a single connection.
 */
export function useAgentPresence(channelName: string) {
  const { presenceData } = usePresenceListener(channelName);

  // Use a ref-based external store for the handover flag so we avoid calling
  // setState directly inside an effect (which triggers the react-hooks/set-state-in-effect rule).
  const handoverStore = useMemo(() => createHandoverStore(), []);

  const handingOver = useSyncExternalStore(
    handoverStore.subscribe,
    handoverStore.getSnapshot,
    handoverStore.getSnapshot
  );

  // An agent member is any presence entry with clientId starting with 'ai-agent:'
  const agentMembers = presenceData.filter(
    (m) => m.clientId?.startsWith('ai-agent:')
  );

  // Determine the best state across all agent members:
  // processing (active) > handing-over (between activities) > absent
  const anyProcessing = agentMembers.some(
    (m) => (m.data as Record<string, unknown>)?.status === 'processing'
  );

  // Agent is actively present if any member is processing OR we are in a handover window
  const agentPresent = anyProcessing || handingOver;

  // Respond to presence changes: detect handover vs. terminal leave.
  useEffect(() => {
    // If an agent is actively processing, cancel any pending handover timeout
    if (anyProcessing) {
      handoverStore.clear();
      return;
    }

    // Check if any member left with handing-over status
    const lastLeaver = presenceData.find(
      (m) => m.clientId?.startsWith('ai-agent:') &&
             m.action === 'leave' &&
             (m.data as Record<string, unknown>)?.status === 'handing-over'
    );

    if (lastLeaver) {
      // Handing over — stay in "thinking" state with a 10-second timeout
      handoverStore.startTimeout(10_000);
    } else if (!anyProcessing) {
      // Terminal leave (no handover data) — agent is gone
      handoverStore.clear();
    }

    return () => {
      handoverStore.clearTimeout();
    };
  }, [presenceData, anyProcessing, handoverStore]);

  return { agentPresent, presenceData };
}

/**
 * Tiny external store for the handover boolean. Mutations happen via
 * imperative methods; React re-renders via useSyncExternalStore.
 */
function createHandoverStore() {
  let value = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  function notify() {
    for (const l of listeners) l();
  }

  return {
    getSnapshot: () => value,
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    startTimeout: (ms: number) => {
      if (timer) clearTimeout(timer);
      if (!value) { value = true; notify(); }
      timer = setTimeout(() => {
        timer = null;
        value = false;
        notify();
      }, ms);
    },
    clear: () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (value) { value = false; notify(); }
    },
    clearTimeout: () => {
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}
