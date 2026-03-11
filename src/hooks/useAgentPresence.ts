/**
 * useAgentPresence — client-side hook for tracking agent presence across
 * serverless step boundaries.
 *
 * Problem: In serverless durable execution (Vercel WDK, AWS Lambda, etc.),
 * each workflow step may run on a different invocation with a different Ably
 * Realtime connection. Presence members are identified by clientId + connectionId,
 * so a leave on connection B doesn't remove a member entered on connection A.
 * Between steps, the agent briefly leaves presence before re-entering on the
 * next step's connection.
 *
 * Solution: Steps leave with { status: 'handing-over' } to signal they're
 * between steps, not crashed. This hook interprets that signal and maintains
 * a stable agent status across step transitions.
 *
 * State resolution uses "best of" logic — if multiple presence members exist
 * for the same agent (e.g., overlapping enter/leave from different connections),
 * the most positive state wins:
 *   processing > handing-over > absent
 *
 * This ensures the UI never briefly flickers to "disconnected" during normal
 * step transitions, even if events arrive out of order.
 *
 * SIMPLIFICATION OPPORTUNITY: Presence is connection+clientId scoped, so
 * durable execution steps must re-enter presence. The SDK should support
 * multiple presence identities on a single connection.
 *
 * NOTE: This pattern is common enough that we believe it should be an SDK-level
 * primitive — something like `channel.subscribeAgentPresence()` that handles
 * handover semantics automatically. The logic here is straightforward but it's
 * boilerplate that every developer building AI agents on serverless will write.
 *
 * Known limitation: On page reload, the in-memory handover state is lost.
 * If the agent was between steps at reload time, the client sees "absent"
 * briefly until the next step enters presence. A server-side agent status
 * API (or LiveObjects with short TTL) would solve this, but adds complexity.
 * For most use cases, the brief flash on reload is acceptable — the next step
 * typically enters within milliseconds.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePresenceListener } from 'ably/react';
import type Ably from 'ably';

export type AgentStatus = 'active' | 'handing-over' | 'absent';

interface UseAgentPresenceOptions {
  /** Prefix to match agent clientIds (default: 'ai-agent') */
  agentClientIdPrefix?: string;
  /** How long to wait for a new step to enter after a handover leave (default: 10000ms) */
  handoverTimeoutMs?: number;
}

interface UseAgentPresenceResult {
  /** Resolved agent status — stable across step transitions */
  agentStatus: AgentStatus;
  /** Whether the agent is actively working (status is 'active' or 'handing-over') */
  agentWorking: boolean;
  /** Clear the handover state immediately — call when you know the turn is done
   *  (e.g., a message received terminal 'complete'/'stopped' status) */
  clearHandover: () => void;
}

export function useAgentPresence(
  channelName: string,
  options: UseAgentPresenceOptions = {}
): UseAgentPresenceResult {
  const {
    agentClientIdPrefix = 'ai-agent',
    handoverTimeoutMs = 10_000,
  } = options;

  const [handingOver, setHandingOver] = useState(false);
  const handoverTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // When clearHandover() is called (e.g., response got terminal status), suppress
  // subsequent handover leaves until a new enter event. This prevents the race where
  // the terminal status update arrives before the presence leave — clearHandover()
  // fires, then the leave re-arms handover for up to 10s.
  const suppressHandoverRef = useRef(false);

  const onPresenceEvent = useCallback(
    (event: Ably.PresenceMessage) => {
      // Only process events for agent clientIds
      if (!event.clientId?.startsWith(agentClientIdPrefix)) return;

      if (event.action === 'leave') {
        const data = event.data as Record<string, unknown> | undefined;
        if (data?.status === 'handing-over' && !suppressHandoverRef.current) {
          // Explicit handover — agent is between steps, expect re-enter soon
          setHandingOver(true);
          clearTimeout(handoverTimeoutRef.current);
          handoverTimeoutRef.current = setTimeout(() => {
            setHandingOver(false);
            // After timeout, status falls through to 'absent'
            // depending on message terminal status (handled by the consumer)
          }, handoverTimeoutMs);
        } else {
          // Non-handover leave, or suppressed after clearHandover()
          setHandingOver(false);
          clearTimeout(handoverTimeoutRef.current);
        }
      }

      if (event.action === 'enter' || event.action === 'update') {
        // Agent (re-)entered — clear any pending handover timeout and reset suppress
        suppressHandoverRef.current = false;
        setHandingOver(false);
        clearTimeout(handoverTimeoutRef.current);
      }
    },
    [agentClientIdPrefix, handoverTimeoutMs]
  );

  const { presenceData } = usePresenceListener(channelName, onPresenceEvent);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => clearTimeout(handoverTimeoutRef.current);
  }, []);

  // Resolve agent status using "best of" logic across all matching members.
  // Multiple members can exist when connections overlap during step transitions.
  const agentMembers = presenceData.filter(
    (m) => m.clientId?.startsWith(agentClientIdPrefix)
  );

  let agentStatus: AgentStatus;
  if (agentMembers.some((m) => (m.data as Record<string, unknown>)?.status === 'processing')) {
    // At least one member is actively processing — agent is working
    agentStatus = 'active';
  } else if (agentMembers.length > 0) {
    // Members present but not processing (e.g., entering, updating)
    agentStatus = 'active';
  } else if (handingOver) {
    // No members present, but a recent handover leave means a step transition
    agentStatus = 'handing-over';
  } else {
    agentStatus = 'absent';
  }

  const agentWorking = agentStatus === 'active' || agentStatus === 'handing-over';

  const clearHandover = useCallback(() => {
    setHandingOver(false);
    clearTimeout(handoverTimeoutRef.current);
    // Suppress subsequent handover leaves until a new enter event
    suppressHandoverRef.current = true;
  }, []);

  return { agentStatus, agentWorking, clearHandover };
}
