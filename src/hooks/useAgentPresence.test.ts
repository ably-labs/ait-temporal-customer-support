import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for the agent presence state machine — the logic that determines
 * agentStatus from presence events and clearHandover calls.
 *
 * We test the pure state logic extracted from useAgentPresence, not the
 * React hook itself, to avoid needing to mock Ably's usePresenceListener.
 */

type AgentStatus = 'active' | 'handing-over' | 'absent';

interface PresenceState {
  handingOver: boolean;
  suppressHandover: boolean;
  agentMembers: { clientId: string; data?: Record<string, unknown> }[];
  handoverTimeout: ReturnType<typeof setTimeout> | undefined;
}

/** Resolve agentStatus from presence state — mirrors useAgentPresence logic. */
function resolveStatus(state: PresenceState): { agentStatus: AgentStatus; agentWorking: boolean } {
  let agentStatus: AgentStatus;
  if (state.agentMembers.some((m) => m.data?.status === 'processing')) {
    agentStatus = 'active';
  } else if (state.agentMembers.length > 0) {
    agentStatus = 'active';
  } else if (state.handingOver) {
    agentStatus = 'handing-over';
  } else {
    agentStatus = 'absent';
  }
  return { agentStatus, agentWorking: agentStatus === 'active' || agentStatus === 'handing-over' };
}

/** Process a presence event — mirrors the onPresenceEvent callback. */
function processEvent(
  state: PresenceState,
  event: { action: string; clientId: string; data?: Record<string, unknown> },
  handoverTimeoutMs = 10_000
): void {
  if (event.action === 'leave') {
    if (event.data?.status === 'handing-over' && !state.suppressHandover) {
      state.handingOver = true;
      clearTimeout(state.handoverTimeout);
      state.handoverTimeout = setTimeout(() => {
        state.handingOver = false;
      }, handoverTimeoutMs);
    } else {
      state.handingOver = false;
      clearTimeout(state.handoverTimeout);
    }
    // Remove from members list
    state.agentMembers = state.agentMembers.filter((m) => m.clientId !== event.clientId);
  }

  if (event.action === 'enter' || event.action === 'update') {
    state.suppressHandover = false;
    state.handingOver = false;
    clearTimeout(state.handoverTimeout);
    // Add/update in members list
    const existing = state.agentMembers.find((m) => m.clientId === event.clientId);
    if (existing) {
      existing.data = event.data;
    } else {
      state.agentMembers.push({ clientId: event.clientId, data: event.data });
    }
  }
}

/** Clear handover — mirrors the clearHandover callback. */
function clearHandover(state: PresenceState): void {
  state.handingOver = false;
  clearTimeout(state.handoverTimeout);
  state.suppressHandover = true;
}

function createPresenceState(): PresenceState {
  return {
    handingOver: false,
    suppressHandover: false,
    agentMembers: [],
    handoverTimeout: undefined,
  };
}

describe('Agent presence state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('basic presence lifecycle', () => {
    it('starts as absent', () => {
      const state = createPresenceState();
      expect(resolveStatus(state)).toEqual({ agentStatus: 'absent', agentWorking: false });
    });

    it('enter → active', () => {
      const state = createPresenceState();
      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      expect(resolveStatus(state)).toEqual({ agentStatus: 'active', agentWorking: true });
    });

    it('enter → leave (non-handover) → absent', () => {
      const state = createPresenceState();
      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      processEvent(state, { action: 'leave', clientId: 'ai-agent-1' });
      expect(resolveStatus(state)).toEqual({ agentStatus: 'absent', agentWorking: false });
    });

    it('enter → leave (handing-over) → handing-over', () => {
      const state = createPresenceState();
      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      processEvent(state, { action: 'leave', clientId: 'ai-agent-1', data: { status: 'handing-over' } });
      expect(resolveStatus(state)).toEqual({ agentStatus: 'handing-over', agentWorking: true });
    });
  });

  describe('step transitions (handover)', () => {
    it('leave(handing-over) → enter = seamless active→active', () => {
      const state = createPresenceState();
      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      expect(resolveStatus(state).agentStatus).toBe('active');

      // Step 1 leaves with handover
      processEvent(state, { action: 'leave', clientId: 'ai-agent-1', data: { status: 'handing-over' } });
      expect(resolveStatus(state).agentStatus).toBe('handing-over');
      expect(resolveStatus(state).agentWorking).toBe(true);

      // Step 2 enters (possibly different connection)
      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      expect(resolveStatus(state).agentStatus).toBe('active');
    });

    it('handover timeout → absent after 10s', () => {
      const state = createPresenceState();
      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      processEvent(state, { action: 'leave', clientId: 'ai-agent-1', data: { status: 'handing-over' } });
      expect(resolveStatus(state).agentStatus).toBe('handing-over');

      // After 10s, handover expires
      vi.advanceTimersByTime(10_000);
      expect(resolveStatus(state)).toEqual({ agentStatus: 'absent', agentWorking: false });
    });

    it('multiple step transitions maintain working state', () => {
      const state = createPresenceState();

      // Step 1
      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      expect(resolveStatus(state).agentWorking).toBe(true);

      // Step 1 → Step 2
      processEvent(state, { action: 'leave', clientId: 'ai-agent-1', data: { status: 'handing-over' } });
      expect(resolveStatus(state).agentWorking).toBe(true);

      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      expect(resolveStatus(state).agentWorking).toBe(true);

      // Step 2 → Step 3
      processEvent(state, { action: 'leave', clientId: 'ai-agent-1', data: { status: 'handing-over' } });
      expect(resolveStatus(state).agentWorking).toBe(true);

      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      expect(resolveStatus(state).agentWorking).toBe(true);
    });
  });

  describe('clearHandover suppression (THE BUG FIX)', () => {
    it('clearHandover before leave prevents re-arming', () => {
      const state = createPresenceState();

      // Agent enters and processes
      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      expect(resolveStatus(state).agentWorking).toBe(true);

      // Terminal status arrives → clearHandover called
      // (This happens when the response message gets status: 'complete')
      clearHandover(state);

      // Agent leaves with handing-over AFTER clearHandover
      // (The presence leave arrives after the message update in real life)
      processEvent(state, { action: 'leave', clientId: 'ai-agent-1', data: { status: 'handing-over' } });

      // Should be absent, NOT handing-over — the leave was suppressed
      expect(resolveStatus(state)).toEqual({ agentStatus: 'absent', agentWorking: false });
    });

    it('WITHOUT suppress fix: clearHandover then leave re-arms (demonstrates the bug)', () => {
      // This test shows what happened before the fix
      const state = createPresenceState();
      // Manually disable suppress to simulate old behavior
      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });

      // clearHandover fires but WITHOUT setting suppress flag
      state.handingOver = false;
      clearTimeout(state.handoverTimeout);
      // Note: NOT setting state.suppressHandover = true (the old behavior)

      // Leave re-arms handover — THIS IS THE BUG
      processEvent(state, { action: 'leave', clientId: 'ai-agent-1', data: { status: 'handing-over' } });
      expect(resolveStatus(state).agentStatus).toBe('handing-over'); // Bug: shows "AI thinking" for 10s
      expect(resolveStatus(state).agentWorking).toBe(true); // Bug: Stop button stays visible
    });

    it('suppress resets on next enter event', () => {
      const state = createPresenceState();
      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      clearHandover(state);
      expect(state.suppressHandover).toBe(true);

      // Leave is suppressed
      processEvent(state, { action: 'leave', clientId: 'ai-agent-1', data: { status: 'handing-over' } });
      expect(resolveStatus(state).agentWorking).toBe(false);

      // New turn: agent enters again → suppress resets
      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      expect(state.suppressHandover).toBe(false);
      expect(resolveStatus(state).agentWorking).toBe(true);

      // Now a handover leave works normally (not suppressed)
      processEvent(state, { action: 'leave', clientId: 'ai-agent-1', data: { status: 'handing-over' } });
      expect(resolveStatus(state).agentStatus).toBe('handing-over');
      expect(resolveStatus(state).agentWorking).toBe(true);
    });

    it('clearHandover while already absent is safe', () => {
      const state = createPresenceState();
      expect(resolveStatus(state).agentStatus).toBe('absent');

      clearHandover(state);
      expect(resolveStatus(state).agentStatus).toBe('absent');
      expect(state.suppressHandover).toBe(true);

      // Next enter still works
      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      expect(resolveStatus(state).agentWorking).toBe(true);
    });
  });

  describe('real-world sequences', () => {
    it('simple text response: enter → stream → terminal status → leave', () => {
      const state = createPresenceState();

      // callLLMStreaming enters presence
      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      expect(resolveStatus(state).agentWorking).toBe(true);

      // Tokens stream... (no presence change)
      // Terminal status 'complete' arrives on client → clearHandover
      clearHandover(state);
      // Agent is still in presence members list so still active
      expect(resolveStatus(state).agentStatus).toBe('active');

      // Presence leave arrives (after terminal status)
      processEvent(state, { action: 'leave', clientId: 'ai-agent-1', data: { status: 'handing-over' } });
      // Should immediately go to absent — NOT 10s wait
      expect(resolveStatus(state)).toEqual({ agentStatus: 'absent', agentWorking: false });
    });

    it('tool use: enter(LLM) → leave → enter(tool) → leave → enter(followUp) → terminal → leave', () => {
      const state = createPresenceState();

      // Step 1: callLLMStreaming
      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      expect(resolveStatus(state).agentWorking).toBe(true);

      // LLM decides tool use, leaves with handover
      processEvent(state, { action: 'leave', clientId: 'ai-agent-1', data: { status: 'handing-over' } });
      expect(resolveStatus(state).agentWorking).toBe(true); // Handover grace period

      // Step 2: executeToolCall enters
      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      expect(resolveStatus(state).agentWorking).toBe(true);

      // Tool completes, leaves with handover
      processEvent(state, { action: 'leave', clientId: 'ai-agent-1', data: { status: 'handing-over' } });
      expect(resolveStatus(state).agentWorking).toBe(true);

      // Step 3: follow-up callLLMStreaming
      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      expect(resolveStatus(state).agentWorking).toBe(true);

      // Terminal status arrives → clearHandover
      clearHandover(state);

      // Presence leave
      processEvent(state, { action: 'leave', clientId: 'ai-agent-1', data: { status: 'handing-over' } });
      // Immediately absent
      expect(resolveStatus(state)).toEqual({ agentStatus: 'absent', agentWorking: false });
    });

    it('stop button: enter → abort → terminal(stopped) → leave', () => {
      const state = createPresenceState();

      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });

      // User clicks stop → abort → terminal status 'stopped' arrives
      clearHandover(state);

      // Leave with handing-over
      processEvent(state, { action: 'leave', clientId: 'ai-agent-1', data: { status: 'handing-over' } });
      expect(resolveStatus(state)).toEqual({ agentStatus: 'absent', agentWorking: false });
    });

    it('escalation: clearHandover on escalation message, then no further presence', () => {
      const state = createPresenceState();

      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      processEvent(state, { action: 'leave', clientId: 'ai-agent-1', data: { status: 'handing-over' } });
      expect(resolveStatus(state).agentWorking).toBe(true);

      // Escalation message arrives → clearHandover
      clearHandover(state);
      expect(resolveStatus(state)).toEqual({ agentStatus: 'absent', agentWorking: false });

      // No 10s timeout — immediately absent
      vi.advanceTimersByTime(10_000);
      expect(resolveStatus(state)).toEqual({ agentStatus: 'absent', agentWorking: false });
    });

    it('two turns back-to-back: first turn completes, second starts', () => {
      const state = createPresenceState();

      // Turn 1
      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      clearHandover(state); // Terminal status
      processEvent(state, { action: 'leave', clientId: 'ai-agent-1', data: { status: 'handing-over' } });
      expect(resolveStatus(state).agentWorking).toBe(false);

      // Turn 2 starts immediately — suppress resets on enter
      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      expect(resolveStatus(state).agentWorking).toBe(true);

      // Turn 2 normal handover (between LLM and tool steps)
      processEvent(state, { action: 'leave', clientId: 'ai-agent-1', data: { status: 'handing-over' } });
      expect(resolveStatus(state).agentStatus).toBe('handing-over');
      expect(resolveStatus(state).agentWorking).toBe(true); // Still working — not suppressed

      // Turn 2 next step enters
      processEvent(state, { action: 'enter', clientId: 'ai-agent-1', data: { status: 'processing' } });
      expect(resolveStatus(state).agentWorking).toBe(true);
    });
  });
});
