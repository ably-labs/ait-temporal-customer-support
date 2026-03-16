/**
 * useAgentPresence — client-side hook for tracking agent presence across
 * serverless step boundaries with multi-agent (double-text) support.
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
 * Multi-agent support: When double-texting creates parallel one-shot workflows,
 * each gets its own taskId-scoped presence member (ai-agent:session:taskId).
 * This hook tracks per-taskId state and exposes an `agents` array.
 *
 * State resolution uses "best of" logic — if multiple presence members exist
 * for the same agent (e.g., overlapping enter/leave from different connections),
 * the most positive state wins:
 *   processing > handing-over > absent
 *
 * SIMPLIFICATION OPPORTUNITY: Presence is connection+clientId scoped, so
 * durable execution steps must re-enter presence. The SDK should support
 * multiple presence identities on a single connection.
 *
 * Known limitation: On page reload, the in-memory handover state is lost.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePresenceListener } from 'ably/react';
import type Ably from 'ably';

export type AgentStatus = 'active' | 'handing-over' | 'absent';

export interface AgentInfo {
  taskId: string;
  status: AgentStatus;
  presenceStatus?: string;
}

interface UseAgentPresenceOptions {
  /** Prefix to match agent clientIds (default: 'ai-agent') */
  agentClientIdPrefix?: string;
  /** How long to wait for a new step to enter after a handover leave (default: 10000ms) */
  handoverTimeoutMs?: number;
}

interface UseAgentPresenceResult {
  /** Resolved agent status — stable across step transitions (considers all agents) */
  agentStatus: AgentStatus;
  /** Whether any agent is actively working (status is 'active' or 'handing-over') */
  agentWorking: boolean;
  /** Per-agent status for multi-agent scenarios */
  agents: AgentInfo[];
  /** Clear the handover state immediately — call when you know the turn is done */
  clearHandover: () => void;
}

/**
 * Extract taskId from a clientId like "ai-agent:session:taskId".
 * Returns 'primary' for "ai-agent:session" (no taskId suffix).
 */
function extractTaskId(clientId: string, sessionPrefix: string): string {
  const afterPrefix = clientId.slice(sessionPrefix.length);
  if (!afterPrefix || afterPrefix === '') return 'primary';
  // afterPrefix starts with ':' if there's a taskId
  if (afterPrefix.startsWith(':')) return afterPrefix.slice(1);
  return 'primary';
}

export function useAgentPresence(
  channelName: string,
  options: UseAgentPresenceOptions = {}
): UseAgentPresenceResult {
  const {
    agentClientIdPrefix = 'ai-agent',
    handoverTimeoutMs = 10_000,
  } = options;

  // Track handover state per taskId
  const [handingOverMap, setHandingOverMap] = useState<Map<string, boolean>>(new Map());
  const handoverTimeoutRefs = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const suppressHandoverRef = useRef(false);

  const onPresenceEvent = useCallback(
    (event: Ably.PresenceMessage) => {
      if (!event.clientId?.startsWith(agentClientIdPrefix)) return;

      // Extract the session prefix to determine taskId
      // clientId format: ai-agent:SESSION or ai-agent:SESSION:TASKID
      const parts = event.clientId.split(':');
      const sessionPrefix = `${parts[0]}:${parts[1]}`;
      const taskId = extractTaskId(event.clientId, sessionPrefix);

      if (event.action === 'leave') {
        const data = event.data as Record<string, unknown> | undefined;

        // 'delivered' leave means task is done — don't trigger handover
        if (data?.status === 'delivered') {
          setHandingOverMap((prev) => {
            const next = new Map(prev);
            next.delete(taskId);
            return next;
          });
          const timer = handoverTimeoutRefs.current.get(taskId);
          if (timer) {
            clearTimeout(timer);
            handoverTimeoutRefs.current.delete(taskId);
          }
          return;
        }

        if (data?.status === 'handing-over' && !suppressHandoverRef.current) {
          setHandingOverMap((prev) => {
            const next = new Map(prev);
            next.set(taskId, true);
            return next;
          });

          const existingTimer = handoverTimeoutRefs.current.get(taskId);
          if (existingTimer) clearTimeout(existingTimer);

          const timer = setTimeout(() => {
            setHandingOverMap((prev) => {
              const next = new Map(prev);
              next.delete(taskId);
              return next;
            });
            handoverTimeoutRefs.current.delete(taskId);
          }, handoverTimeoutMs);
          handoverTimeoutRefs.current.set(taskId, timer);
        } else {
          setHandingOverMap((prev) => {
            const next = new Map(prev);
            next.delete(taskId);
            return next;
          });
          const timer = handoverTimeoutRefs.current.get(taskId);
          if (timer) {
            clearTimeout(timer);
            handoverTimeoutRefs.current.delete(taskId);
          }
        }
      }

      if (event.action === 'enter' || event.action === 'update') {
        suppressHandoverRef.current = false;
        setHandingOverMap((prev) => {
          const next = new Map(prev);
          next.delete(taskId);
          return next;
        });
        const timer = handoverTimeoutRefs.current.get(taskId);
        if (timer) {
          clearTimeout(timer);
          handoverTimeoutRefs.current.delete(taskId);
        }
      }
    },
    [agentClientIdPrefix, handoverTimeoutMs]
  );

  const { presenceData } = usePresenceListener(channelName, onPresenceEvent);

  // Cleanup timeouts on unmount
  useEffect(() => {
    const refs = handoverTimeoutRefs.current;
    return () => {
      refs.forEach((timer) => clearTimeout(timer));
    };
  }, []);

  // Build per-agent status from presence data
  const agentMembers = presenceData.filter(
    (m) => m.clientId?.startsWith(agentClientIdPrefix)
  );

  // Group by taskId
  const taskIdMembers = new Map<string, Ably.PresenceMessage[]>();
  for (const m of agentMembers) {
    const parts = m.clientId!.split(':');
    const sessionPrefix = `${parts[0]}:${parts[1]}`;
    const taskId = extractTaskId(m.clientId!, sessionPrefix);
    const existing = taskIdMembers.get(taskId) ?? [];
    existing.push(m);
    taskIdMembers.set(taskId, existing);
  }

  // Resolve status per taskId
  const agents: AgentInfo[] = [];
  const allTaskIds = new Set([...taskIdMembers.keys(), ...handingOverMap.keys()]);

  for (const taskId of allTaskIds) {
    const members = taskIdMembers.get(taskId) ?? [];
    const isHandingOver = handingOverMap.get(taskId) ?? false;

    let status: AgentStatus;
    let presenceStatus: string | undefined;

    if (members.some((m) => (m.data as Record<string, unknown>)?.status === 'processing')) {
      status = 'active';
      presenceStatus = 'processing';
    } else if (members.some((m) => (m.data as Record<string, unknown>)?.status === 'waiting-to-deliver')) {
      status = 'active';
      presenceStatus = 'waiting-to-deliver';
    } else if (members.some((m) => (m.data as Record<string, unknown>)?.status === 'delivering')) {
      status = 'active';
      presenceStatus = 'delivering';
    } else if (members.length > 0) {
      status = 'active';
    } else if (isHandingOver) {
      status = 'handing-over';
    } else {
      // No members and not handing over — skip (agent is gone)
      continue;
    }

    agents.push({ taskId, status, presenceStatus });
  }

  // Aggregate status: any agent active = active, any handing over = handing-over, else absent
  let agentStatus: AgentStatus;
  if (agents.some((a) => a.status === 'active')) {
    agentStatus = 'active';
  } else if (agents.some((a) => a.status === 'handing-over')) {
    agentStatus = 'handing-over';
  } else {
    agentStatus = 'absent';
  }

  const agentWorking = agentStatus === 'active' || agentStatus === 'handing-over';

  const clearHandover = useCallback(() => {
    setHandingOverMap(new Map());
    handoverTimeoutRefs.current.forEach((timer) => clearTimeout(timer));
    handoverTimeoutRefs.current.clear();
    suppressHandoverRef.current = true;
  }, []);

  return { agentStatus, agentWorking, agents, clearHandover };
}
