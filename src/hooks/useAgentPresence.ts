'use client';

import { useEffect, useRef, useState } from 'react';
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
  const handoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [handingOver, setHandingOver] = useState(false);

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

  // Listen for presence leave events to detect handover vs. terminal leave
  useEffect(() => {
    const handlePresenceLeave = () => {
      // Check if any remaining members are still processing
      const stillProcessing = agentMembers.some(
        (m) => (m.data as Record<string, unknown>)?.status === 'processing'
      );
      if (stillProcessing) return;

      // Check if any member left with handing-over status
      const lastLeaver = presenceData.find(
        (m) => m.clientId?.startsWith('ai-agent:') &&
               m.action === 'leave' &&
               (m.data as Record<string, unknown>)?.status === 'handing-over'
      );

      if (lastLeaver) {
        // Handing over — stay in "thinking" state with a 10-second timeout
        setHandingOver(true);
        if (handoverTimeoutRef.current) clearTimeout(handoverTimeoutRef.current);
        handoverTimeoutRef.current = setTimeout(() => {
          setHandingOver(false);
          handoverTimeoutRef.current = null;
        }, 10_000);
      } else {
        // Terminal leave (no handover data) — agent is gone
        setHandingOver(false);
        if (handoverTimeoutRef.current) {
          clearTimeout(handoverTimeoutRef.current);
          handoverTimeoutRef.current = null;
        }
      }
    };

    handlePresenceLeave();

    return () => {
      if (handoverTimeoutRef.current) {
        clearTimeout(handoverTimeoutRef.current);
      }
    };
  }, [presenceData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear handover state when an agent enters (new activity started)
  useEffect(() => {
    if (anyProcessing && handingOver) {
      setHandingOver(false);
      if (handoverTimeoutRef.current) {
        clearTimeout(handoverTimeoutRef.current);
        handoverTimeoutRef.current = null;
      }
    }
  }, [anyProcessing, handingOver]);

  return { agentPresent, presenceData };
}
