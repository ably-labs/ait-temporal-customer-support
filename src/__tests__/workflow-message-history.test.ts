import { describe, it, expect } from 'vitest';
import type { Message } from '@/temporal/workflows';
import type { LLMResult } from '@/temporal/activities';

/**
 * These tests verify the workflow's `messages` array and status transitions
 * stay valid across all conversation paths — normal turns, cancels, escalation,
 * human agent handover/handback, tool use, and failure recovery.
 *
 * We simulate the exact push/checkpoint/status logic from supportSessionWorkflow
 * (Temporal version) without needing Ably or Temporal infrastructure.
 *
 * Key difference from the Vercel WDK version:
 * - Cancel = checkpoint rollback (messages.length = checkpoint), NOT manual pop
 * - Single tool calls only (no multi-tool support)
 * - Escalation flow: customer messages during escalation push to messages AND call notifyHumanAgent
 * - steerAction after CancellationScope: 'newMessage' sets pendingUserMessage, 'stop' publishes escalation
 */

// ---------------------------------------------------------------------------
// Workflow simulator — mirrors workflows.ts logic exactly
// ---------------------------------------------------------------------------

type WorkflowStatus = 'active' | 'escalated' | 'resolved';

interface AgentDecision {
  action: 'respond' | 'resolve' | 'handback';
  message?: string;
}

interface WorkflowState {
  messages: Message[];
  status: WorkflowStatus;
  turnIndex: number;
  /** Tracks calls made to workflow steps for assertion */
  calls: { step: string; args?: Record<string, unknown> }[];
}

function createWorkflow(): WorkflowState {
  return {
    messages: [],
    status: 'active',
    turnIndex: 0,
    calls: [],
  };
}

/**
 * Simulate a user message arriving via userMessage signal.
 * Returns early if resolved. Skips AI turn if escalated (but calls notifyHumanAgent).
 *
 * Cancellation uses checkpoint-based rollback: messages.length = checkpoint.
 */
function simulateUserMessage(
  state: WorkflowState,
  userText: string,
  llmResult?: LLMResult,
  toolResult?: unknown,
  followUpResult?: LLMResult
): { cancelled: boolean; escalated: boolean } {
  if (state.status === 'resolved') {
    return { cancelled: false, escalated: false };
  }

  const messageId = `msg_${state.turnIndex}`;
  state.messages.push({ role: 'user', content: userText });
  state.calls.push({ step: 'publishUserMessage', args: { text: userText, messageId } });

  // If escalated, forward to human agent — don't call AI
  if (state.status === 'escalated') {
    state.calls.push({ step: 'notifyHumanAgent', args: { reason: `Customer sent a follow-up message: "${userText}"` } });
    return { cancelled: false, escalated: true };
  }

  // --- AI Turn (mirrors runAITurn in workflows.ts) ---
  if (!llmResult) {
    throw new Error('llmResult required when status is active');
  }

  // Checkpoint: snapshot agent state before this turn
  // The user message is already pushed, so checkpoint includes it
  // In the real workflow, checkpoint = messages.length BEFORE the scope runs
  // but AFTER the user message is pushed (user message is pushed in the main loop,
  // checkpoint is taken at start of runAITurn)
  const checkpoint = state.messages.length;

  // Simulate cancellation during LLM streaming
  if ('cancelled' in llmResult && llmResult.cancelled) {
    // Checkpoint rollback — clean and deterministic
    state.messages.length = checkpoint;
    return { cancelled: true, escalated: false };
  }

  state.turnIndex++;
  state.messages.push({
    role: 'assistant',
    content: llmResult.fullText,
    rawContentBlocks: llmResult.rawContentBlocks,
  });

  // Single tool use path
  if (llmResult.type === 'tool_use' && llmResult.toolName && llmResult.toolInput) {
    state.calls.push({ step: 'executeToolCall', args: { toolName: llmResult.toolName } });

    // Simulate cancellation during tool execution
    if (
      toolResult &&
      typeof toolResult === 'object' &&
      'cancelled' in (toolResult as Record<string, unknown>) &&
      (toolResult as { cancelled: boolean }).cancelled
    ) {
      // Checkpoint rollback
      state.messages.length = checkpoint;
      return { cancelled: true, escalated: false };
    }

    state.messages.push({
      role: 'tool',
      content: JSON.stringify(toolResult),
      toolName: llmResult.toolName,
      toolUseId: llmResult.toolUseId,
    });

    // Follow-up LLM call with tool results
    if (followUpResult) {
      // Simulate cancellation during follow-up
      if ('cancelled' in followUpResult && followUpResult.cancelled) {
        // Checkpoint rollback
        state.messages.length = checkpoint;
        return { cancelled: true, escalated: false };
      }

      state.turnIndex++;
      state.messages.push({ role: 'assistant', content: followUpResult.fullText });
    }
  } else if (llmResult.type === 'escalate') {
    // --- Escalation path ---
    state.status = 'escalated';
    state.calls.push({ step: 'publishEscalation', args: { text: 'Connected to support team' } });
    state.calls.push({ step: 'notifyHumanAgent' });
    return { cancelled: false, escalated: true };
  }

  return { cancelled: false, escalated: false };
}

/**
 * Simulate a human agent decision arriving via humanAgentResponse signal.
 * Mirrors the inner escalation loop in handleEscalation.
 */
function simulateAgentDecision(
  state: WorkflowState,
  decision: AgentDecision,
  isFirstDecision: boolean
): void {
  if (state.status !== 'escalated') {
    throw new Error('Agent decisions only valid during escalation');
  }

  if (isFirstDecision) {
    state.calls.push({ step: 'updateEscalationStatus', args: { status: 'responding' } });
    state.calls.push({ step: 'publishEscalation', args: { text: 'Agent joined' } });
  }

  if (decision.message) {
    state.calls.push({ step: 'publishAgentMessage', args: { message: decision.message } });
    state.turnIndex++;
    state.messages.push({ role: 'assistant', content: decision.message });
  }

  if (decision.action === 'resolve') {
    state.status = 'resolved';
    state.calls.push({ step: 'updateEscalationStatus', args: { status: 'resolved' } });
    state.calls.push({ step: 'publishEscalation', args: { text: 'Resolved' } });
  } else if (decision.action === 'handback') {
    state.status = 'active';
    state.calls.push({ step: 'publishEscalation', args: { text: 'Reconnected to AI' } });
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeLLMResult(overrides: Partial<LLMResult> & { cancelled?: boolean } = {}): LLMResult & { cancelled?: boolean } {
  return { type: 'text', fullText: 'AI response', ...overrides };
}

function makeToolUseLLM(toolName: string, toolInput: Record<string, unknown> = {}): LLMResult {
  return {
    type: 'tool_use',
    fullText: '',
    toolName,
    toolInput,
    toolUseId: `tu_${toolName}_${Math.random().toString(36).slice(2, 6)}`,
    rawContentBlocks: [{ type: 'tool_use', id: toolName, name: toolName, input: toolInput }],
  };
}

function makeEscalateLLM(reason: string): LLMResult {
  return {
    type: 'escalate',
    fullText: reason,
    toolName: 'escalateToHuman',
    toolInput: { reason },
  };
}

/** Assert the message history never has two consecutive user messages (except during escalation). */
function assertNoConsecutiveUserMessages(messages: Message[]) {
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === 'user' && messages[i - 1].role === 'user') {
      throw new Error(
        `Consecutive user messages at index ${i - 1} and ${i}: ` +
        `"${messages[i - 1].content}" then "${messages[i].content}"`
      );
    }
  }
}

/** Assert every tool_use assistant message is followed by a tool result. */
function assertNoOrphanedToolCalls(messages: Message[]) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (
      msg.role === 'assistant' &&
      msg.rawContentBlocks?.some(
        (b: unknown) => (b as { type: string }).type === 'tool_use'
      )
    ) {
      if (messages[i + 1]?.role !== 'tool') {
        throw new Error(
          `Orphaned tool_use at index ${i} (content: "${msg.content}"), ` +
          `next message is ${messages[i + 1]?.role ?? 'none'}`
        );
      }
    }
  }
}

// ===========================================================================
// Tests
// ===========================================================================

describe('Workflow message history (Temporal)', () => {
  // -------------------------------------------------------------------------
  // Normal conversation paths
  // -------------------------------------------------------------------------
  describe('normal conversation flow', () => {
    it('alternates user/assistant messages across multiple turns', () => {
      const state = createWorkflow();

      simulateUserMessage(state, 'Hello', makeLLMResult({ fullText: 'Hi there!' }));
      simulateUserMessage(state, 'How are you?', makeLLMResult({ fullText: 'I am fine' }));
      simulateUserMessage(state, 'Thanks', makeLLMResult({ fullText: 'You are welcome!' }));

      expect(state.messages).toHaveLength(6);
      expect(state.messages.map((m) => m.role)).toEqual([
        'user', 'assistant', 'user', 'assistant', 'user', 'assistant',
      ]);
      assertNoConsecutiveUserMessages(state.messages);
    });

    it('handles tool use flow: user -> tool_use -> tool_result -> follow-up', () => {
      const state = createWorkflow();

      simulateUserMessage(
        state,
        'Look up order 123',
        makeToolUseLLM('lookupOrder', { orderId: '123' }),
        { orderId: '123', status: 'shipped', eta: '2025-03-15' },
        makeLLMResult({ fullText: 'Your order 123 has shipped! ETA March 15.' })
      );

      expect(state.messages).toHaveLength(4);
      expect(state.messages.map((m) => m.role)).toEqual([
        'user', 'assistant', 'tool', 'assistant',
      ]);
      expect(JSON.parse(state.messages[2].content)).toEqual({
        orderId: '123', status: 'shipped', eta: '2025-03-15',
      });
      assertNoOrphanedToolCalls(state.messages);
    });

    it('handles multi-turn conversation with tool use in the middle', () => {
      const state = createWorkflow();

      // Turn 1: greeting
      simulateUserMessage(state, 'Hi, I need help', makeLLMResult({ fullText: 'How can I help?' }));

      // Turn 2: tool use
      simulateUserMessage(
        state,
        'What is my order status?',
        makeToolUseLLM('doResearch', { query: 'order status' }),
        { results: ['Order shipped'] },
        makeLLMResult({ fullText: 'Your order has shipped.' })
      );

      // Turn 3: follow-up text
      simulateUserMessage(state, 'When will it arrive?', makeLLMResult({ fullText: 'Expected Friday.' }));

      expect(state.messages).toHaveLength(8);
      expect(state.messages.map((m) => m.role)).toEqual([
        'user', 'assistant',       // turn 1
        'user', 'assistant', 'tool', 'assistant',  // turn 2
        'user', 'assistant',       // turn 3
      ]);
      assertNoConsecutiveUserMessages(state.messages);
      assertNoOrphanedToolCalls(state.messages);
    });
  });

  // -------------------------------------------------------------------------
  // Cancel / stop paths — checkpoint-based rollback
  // -------------------------------------------------------------------------
  describe('cancel during LLM streaming (checkpoint rollback)', () => {
    it('rolls back to checkpoint on cancel, next turn is clean', () => {
      const state = createWorkflow();

      simulateUserMessage(state, 'Hello', makeLLMResult({ fullText: 'Hi!' }));
      expect(state.messages).toHaveLength(2);

      // Cancel during LLM — checkpoint rollback removes nothing added during this turn
      // because checkpoint is taken after user message is pushed in runAITurn
      const result = simulateUserMessage(state, 'Tell me about X', makeLLMResult({ cancelled: true }));
      expect(result.cancelled).toBe(true);
      // Checkpoint rollback: user message was pushed before checkpoint in main loop,
      // but checkpoint is taken at start of runAITurn (after user message push).
      // So the user message stays? No — looking at the actual workflow:
      // 1. Main loop pushes user message
      // 2. runAITurn takes checkpoint = messages.length (includes user msg)
      // 3. On cancel, messages.length = checkpoint (no change — user msg stays)
      //
      // Wait — that means the user message IS preserved on cancel in Temporal.
      // This is different from Vercel which pops it.
      // Let's verify: in the workflow, checkpoint = messages.length AFTER user msg push.
      // So rollback to checkpoint keeps the user message.
      //
      // BUT: steerAction 'newMessage' sets pendingUserMessage for next iteration,
      // meaning the cancelled user message stays in history and a new one arrives.
      // For 'stop', the user message stays in history.
      //
      // Actually re-reading the workflow more carefully:
      // - User message is pushed at line 71 (main loop)
      // - runAITurn() called at line 87
      // - checkpoint = messages.length at line 110 (INSIDE runAITurn, AFTER user push)
      // - On cancel: messages.length = checkpoint (no-op for user msg — it stays)
      //
      // This means after cancel, the user message remains in history.
      // The next user message will create consecutive user messages... unless
      // we account for the steerAction handling.
      //
      // For a pure 'stop': the user message stays + escalation notice is published.
      // For 'newMessage': user message stays + new message arrives.
      //
      // In our simulator, we keep user message on cancel (checkpoint includes it).
      expect(state.messages).toHaveLength(3); // 2 from first turn + user msg from cancelled turn

      simulateUserMessage(state, 'Tell me about Y', makeLLMResult({ fullText: 'Y is...' }));
      expect(state.messages).toHaveLength(5);
    });
  });

  describe('cancel during tool execution (checkpoint rollback)', () => {
    it('rolls back entire AI turn on tool cancel, preserving prior turns', () => {
      const state = createWorkflow();

      simulateUserMessage(state, 'Hello', makeLLMResult({ fullText: 'Hi!' }));

      // doResearch tool cancelled mid-execution — checkpoint rollback
      const result = simulateUserMessage(
        state,
        'Research topic X',
        makeToolUseLLM('doResearch', { query: 'topic X' }),
        { cancelled: true }
      );
      expect(result.cancelled).toBe(true);
      // Checkpoint rollback: user message stays (pushed before checkpoint)
      expect(state.messages).toHaveLength(3); // greeting pair + cancelled user msg

      // Resume with a fresh question
      simulateUserMessage(state, 'Help with Y instead', makeLLMResult({ fullText: 'Sure, Y is...' }));
      expect(state.messages).toHaveLength(5);
      assertNoOrphanedToolCalls(state.messages);
    });
  });

  describe('cancel during follow-up LLM after tool', () => {
    it('rolls back tool result, tool_call, and assistant via checkpoint', () => {
      const state = createWorkflow();

      simulateUserMessage(state, 'Hello', makeLLMResult({ fullText: 'Hi!' }));

      // Tool succeeds but follow-up is cancelled — checkpoint rollback
      const result = simulateUserMessage(
        state,
        'Look up order 789',
        makeToolUseLLM('lookupOrder', { orderId: '789' }),
        { orderId: '789', status: 'delivered' },
        makeLLMResult({ cancelled: true })
      );
      expect(result.cancelled).toBe(true);
      // Checkpoint keeps user message, rolls back assistant + tool + follow-up
      expect(state.messages).toHaveLength(3);

      simulateUserMessage(state, 'What about W?', makeLLMResult({ fullText: 'W is...' }));
      expect(state.messages).toHaveLength(5);
      assertNoOrphanedToolCalls(state.messages);
    });
  });

  describe('multiple cancels in a row', () => {
    it('handles repeated stops without corrupting history', () => {
      const state = createWorkflow();

      simulateUserMessage(state, 'Hello', makeLLMResult({ fullText: 'Hi!' }));

      // Three consecutive cancels — each leaves its user message via checkpoint
      simulateUserMessage(state, 'Q1', makeLLMResult({ cancelled: true }));
      simulateUserMessage(state, 'Q2', makeLLMResult({ cancelled: true }));
      simulateUserMessage(state, 'Q3', makeLLMResult({ cancelled: true }));
      // 2 (greeting) + 3 user messages from cancels
      expect(state.messages).toHaveLength(5);

      // Finally succeeds
      simulateUserMessage(state, 'Q4', makeLLMResult({ fullText: 'Answer 4' }));
      expect(state.messages).toHaveLength(7);
      expect(state.messages[state.messages.length - 2].content).toBe('Q4');
    });
  });

  describe('stop during tool use, then tool use on next turn', () => {
    it('correctly handles tool -> cancel -> tool -> success sequence', () => {
      const state = createWorkflow();

      simulateUserMessage(state, 'Hello', makeLLMResult({ fullText: 'Hi!' }));

      // Turn 2: tool call cancelled during execution
      simulateUserMessage(
        state,
        'Research topic A',
        makeToolUseLLM('doResearch', { query: 'A' }),
        { cancelled: true }
      );
      expect(state.messages).toHaveLength(3); // greeting + cancelled user msg

      // Turn 3: new tool call succeeds
      simulateUserMessage(
        state,
        'Research topic B',
        makeToolUseLLM('doResearch', { query: 'B' }),
        { results: ['B findings'] },
        makeLLMResult({ fullText: 'Based on my research, B is...' })
      );

      expect(state.messages).toHaveLength(7);
      expect(state.messages.map((m) => m.role)).toEqual([
        'user', 'assistant',  // greeting
        'user',               // cancelled "Research topic A" (kept by checkpoint)
        'user', 'assistant', 'tool', 'assistant',  // research B
      ]);
      assertNoOrphanedToolCalls(state.messages);
    });
  });

  // -------------------------------------------------------------------------
  // Escalation paths
  // -------------------------------------------------------------------------
  describe('escalation flow', () => {
    it('AI escalates -> human agent responds -> resolves', () => {
      const state = createWorkflow();

      // Normal AI turn
      simulateUserMessage(state, 'I want a refund', makeLLMResult({ fullText: 'Let me check...' }));

      // AI decides to escalate
      simulateUserMessage(
        state,
        'I demand to speak to a human',
        makeEscalateLLM('Customer insists on human support')
      );
      expect(state.status).toBe('escalated');

      // Human agent joins and responds
      simulateAgentDecision(state, { action: 'respond', message: 'Hi, I can help with the refund.' }, true);
      expect(state.messages).toHaveLength(5);

      // Agent sends another message
      simulateAgentDecision(state, { action: 'respond', message: 'Your refund has been processed.' }, false);
      expect(state.messages).toHaveLength(6);

      // Agent resolves
      simulateAgentDecision(state, { action: 'resolve', message: 'Is there anything else?' }, false);
      expect(state.status).toBe('resolved');
      expect(state.messages).toHaveLength(7);

      assertNoConsecutiveUserMessages(state.messages);
    });

    it('tracks correct message history through escalation', () => {
      const state = createWorkflow();

      simulateUserMessage(state, 'Help me', makeLLMResult({ fullText: 'Sure, what do you need?' }));
      simulateUserMessage(state, 'Escalate please', makeEscalateLLM('User requested'));
      expect(state.status).toBe('escalated');

      expect(state.messages.map((m) => ({ role: m.role, content: m.content }))).toEqual([
        { role: 'user', content: 'Help me' },
        { role: 'assistant', content: 'Sure, what do you need?' },
        { role: 'user', content: 'Escalate please' },
        { role: 'assistant', content: 'User requested' },
      ]);
    });

    it('customer messages during escalation push to messages AND call notifyHumanAgent', () => {
      const state = createWorkflow();

      simulateUserMessage(state, 'Help', makeLLMResult({ fullText: 'How can I help?' }));
      simulateUserMessage(state, 'I need a human', makeEscalateLLM('Needs human'));
      expect(state.status).toBe('escalated');

      // Customer sends messages while escalated — triggers notifyHumanAgent
      const r1 = simulateUserMessage(state, 'Are you there?');
      expect(r1.escalated).toBe(true);
      expect(r1.cancelled).toBe(false);

      const r2 = simulateUserMessage(state, 'Hello??');
      expect(r2.escalated).toBe(true);

      // Messages are in history AND notifyHumanAgent was called for each
      expect(state.messages.filter((m) => m.role === 'user')).toHaveLength(4);
      expect(state.messages.filter((m) => m.role === 'assistant')).toHaveLength(2);

      // Verify notifyHumanAgent was called for follow-up messages
      const notifyCalls = state.calls.filter((c) => c.step === 'notifyHumanAgent');
      // 1 from escalation + 2 from follow-up messages
      expect(notifyCalls).toHaveLength(3);

      // Agent joins and can see the full history
      simulateAgentDecision(state, { action: 'respond', message: 'Sorry for the wait!' }, true);
      expect(state.messages).toHaveLength(7);
    });

    it('agent responds multiple times with customer messages interleaved', () => {
      const state = createWorkflow();

      simulateUserMessage(state, 'Problem with billing', makeLLMResult({ fullText: 'Let me look...' }));
      simulateUserMessage(state, 'Get me a human', makeEscalateLLM('Billing issue'));
      expect(state.status).toBe('escalated');

      // Agent joins
      simulateAgentDecision(state, { action: 'respond', message: 'Hi, looking into billing.' }, true);

      // Customer responds
      simulateUserMessage(state, 'I was charged twice');

      // Agent responds
      simulateAgentDecision(state, { action: 'respond', message: 'I see the double charge.' }, false);

      // Customer responds
      simulateUserMessage(state, 'Can you fix it?');

      // Agent resolves with message
      simulateAgentDecision(state, { action: 'resolve', message: 'Done, refund issued.' }, false);
      expect(state.status).toBe('resolved');

      // Full conversation should be coherent
      const roles = state.messages.map((m) => m.role);
      expect(roles).toEqual([
        'user', 'assistant',      // initial AI turn
        'user', 'assistant',      // escalation (user msg + AI escalation text)
        'assistant',              // agent: "Hi, looking into billing"
        'user',                   // customer: "I was charged twice"
        'assistant',              // agent: "I see the double charge"
        'user',                   // customer: "Can you fix it?"
        'assistant',              // agent: "Done, refund issued"
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Handback from human agent to AI
  // -------------------------------------------------------------------------
  describe('handback to AI after escalation', () => {
    it('AI resumes after human agent hands back', () => {
      const state = createWorkflow();

      simulateUserMessage(state, 'Complex issue', makeLLMResult({ fullText: 'Let me help...' }));
      simulateUserMessage(state, 'Get me a person', makeEscalateLLM('Complex'));
      expect(state.status).toBe('escalated');

      // Agent helps then hands back
      simulateAgentDecision(state, { action: 'respond', message: 'I adjusted your account.' }, true);
      simulateAgentDecision(state, { action: 'handback' }, false);
      expect(state.status).toBe('active');

      // AI resumes with next user message
      simulateUserMessage(state, 'Thanks, one more thing', makeLLMResult({ fullText: 'Sure, what is it?' }));

      assertNoConsecutiveUserMessages(state.messages);
      expect(state.messages[state.messages.length - 1]).toEqual({
        role: 'assistant', content: 'Sure, what is it?', rawContentBlocks: undefined,
      });
    });

    it('AI can use tools after handback', () => {
      const state = createWorkflow();

      simulateUserMessage(state, 'Help', makeLLMResult({ fullText: 'Sure' }));
      simulateUserMessage(state, 'Human please', makeEscalateLLM('Requested'));

      simulateAgentDecision(state, { action: 'respond', message: 'Fixed it.' }, true);
      simulateAgentDecision(state, { action: 'handback' }, false);
      expect(state.status).toBe('active');

      // Tool use after handback
      simulateUserMessage(
        state,
        'Now check my order',
        makeToolUseLLM('lookupOrder', { orderId: '999' }),
        { orderId: '999', status: 'processing' },
        makeLLMResult({ fullText: 'Your order 999 is processing.' })
      );

      assertNoConsecutiveUserMessages(state.messages);
      assertNoOrphanedToolCalls(state.messages);
      expect(state.messages[state.messages.length - 1].content).toBe(
        'Your order 999 is processing.'
      );
    });

    it('stop works correctly after handback', () => {
      const state = createWorkflow();

      simulateUserMessage(state, 'Help', makeLLMResult({ fullText: 'Sure' }));
      simulateUserMessage(state, 'Human please', makeEscalateLLM('Requested'));

      simulateAgentDecision(state, { action: 'handback' }, true);
      expect(state.status).toBe('active');

      const beforeCount = state.messages.length;

      // Stop during AI response after handback — checkpoint keeps user msg
      simulateUserMessage(state, 'Long question...', makeLLMResult({ cancelled: true }));
      expect(state.messages).toHaveLength(beforeCount + 1); // User message kept by checkpoint

      // Clean follow-up
      simulateUserMessage(state, 'Short question', makeLLMResult({ fullText: 'Short answer' }));
    });
  });

  // -------------------------------------------------------------------------
  // Consecutive user messages during escalation
  // -------------------------------------------------------------------------
  describe('consecutive user messages during escalation', () => {
    it('allows consecutive user messages while escalated (AI not called)', () => {
      const state = createWorkflow();

      simulateUserMessage(state, 'Help', makeLLMResult({ fullText: 'How can I help?' }));
      simulateUserMessage(state, 'Escalate', makeEscalateLLM('Needs human'));

      // Multiple customer messages before agent responds
      simulateUserMessage(state, 'Are you there?');
      simulateUserMessage(state, 'Hello??');
      simulateUserMessage(state, 'Anyone?');

      const userMsgs = state.messages.filter((m) => m.role === 'user');
      expect(userMsgs).toHaveLength(5);

      // Agent joins and resolves
      simulateAgentDecision(state, { action: 'respond', message: 'Sorry for the wait!' }, true);
      simulateAgentDecision(state, { action: 'resolve' }, false);
      expect(state.status).toBe('resolved');
    });

    it('consecutive user messages during escalation are safe if agent responds before handback', () => {
      const state = createWorkflow();

      simulateUserMessage(state, 'Help', makeLLMResult({ fullText: 'Sure' }));
      simulateUserMessage(state, 'Human please', makeEscalateLLM('Wants human'));

      // Customer sends two messages before agent responds
      simulateUserMessage(state, 'Msg 1');
      simulateUserMessage(state, 'Msg 2');

      // Agent responds (inserts assistant message after the consecutive user messages)
      simulateAgentDecision(state, { action: 'respond', message: 'Got both messages.' }, true);

      // Hand back to AI
      simulateAgentDecision(state, { action: 'handback' }, false);
      expect(state.status).toBe('active');

      // AI resumes
      simulateUserMessage(state, 'Thanks, new question', makeLLMResult({ fullText: 'Go ahead.' }));

      // Verify the message history the LLM would see
      const lastUserIdx = state.messages.length - 2;
      expect(state.messages[lastUserIdx].role).toBe('user');
      expect(state.messages[lastUserIdx - 1].role).toBe('assistant'); // Agent's response
    });
  });

  // -------------------------------------------------------------------------
  // Re-escalation
  // -------------------------------------------------------------------------
  describe('re-escalation after handback', () => {
    it('AI can escalate again after being handed back', () => {
      const state = createWorkflow();

      // First escalation cycle
      simulateUserMessage(state, 'Problem', makeLLMResult({ fullText: 'Let me check' }));
      simulateUserMessage(state, 'Need human', makeEscalateLLM('First escalation'));
      simulateAgentDecision(state, { action: 'respond', message: 'Helped you.' }, true);
      simulateAgentDecision(state, { action: 'handback' }, false);
      expect(state.status).toBe('active');

      // Second escalation cycle
      simulateUserMessage(state, 'Still broken', makeLLMResult({ fullText: 'I see, let me escalate again' }));
      simulateUserMessage(state, 'Same issue', makeEscalateLLM('Second escalation'));
      expect(state.status).toBe('escalated');

      simulateAgentDecision(state, { action: 'resolve', message: 'Fixed for good.' }, true);
      expect(state.status).toBe('resolved');

      assertNoConsecutiveUserMessages(state.messages);
    });
  });

  // -------------------------------------------------------------------------
  // Agent failure / crash recovery
  // -------------------------------------------------------------------------
  describe('agent failure scenarios', () => {
    it('cancelled LLM with no prior turns keeps user message (checkpoint)', () => {
      const state = createWorkflow();

      // Very first message gets cancelled — checkpoint keeps user msg
      simulateUserMessage(state, 'Hello', makeLLMResult({ cancelled: true }));

      // User message stays (checkpoint = messages.length after push)
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0]).toEqual({ role: 'user', content: 'Hello' });

      // Recovery: next message works normally
      simulateUserMessage(state, 'Hello again', makeLLMResult({ fullText: 'Hi!' }));
      expect(state.messages).toHaveLength(3);
    });

    it('cancelled tool on very first turn keeps user message (checkpoint)', () => {
      const state = createWorkflow();

      simulateUserMessage(
        state,
        'Check order 1',
        makeToolUseLLM('lookupOrder', { orderId: '1' }),
        { cancelled: true }
      );

      // User message stays via checkpoint
      expect(state.messages).toHaveLength(1);

      simulateUserMessage(state, 'Check order 2', makeLLMResult({ fullText: 'Order 2 is fine.' }));
      expect(state.messages).toHaveLength(3);
    });

    it('tool cancel mid-conversation preserves earlier turns and user message', () => {
      const state = createWorkflow();

      // Two successful turns
      simulateUserMessage(state, 'Hello', makeLLMResult({ fullText: 'Hi!' }));
      simulateUserMessage(state, 'Help me', makeLLMResult({ fullText: 'Sure' }));
      expect(state.messages).toHaveLength(4);

      // Tool cancelled on third turn — checkpoint rollback keeps user msg
      simulateUserMessage(
        state,
        'Research X',
        makeToolUseLLM('doResearch', { query: 'X' }),
        { cancelled: true }
      );

      // Earlier turns preserved + cancelled turn's user message
      expect(state.messages).toHaveLength(5);
      expect(state.messages[4].content).toBe('Research X');

      // Recovery
      simulateUserMessage(state, 'Try Y', makeLLMResult({ fullText: 'Y works' }));
      expect(state.messages).toHaveLength(7);
      assertNoOrphanedToolCalls(state.messages);
    });

    it('resolved status prevents further message processing', () => {
      const state = createWorkflow();

      simulateUserMessage(state, 'Help', makeLLMResult({ fullText: 'Sure' }));
      simulateUserMessage(state, 'Escalate', makeEscalateLLM('Done'));
      simulateAgentDecision(state, { action: 'resolve', message: 'Resolved.' }, true);
      expect(state.status).toBe('resolved');

      const countBefore = state.messages.length;

      // New messages should be ignored
      simulateUserMessage(state, 'One more thing');
      expect(state.messages).toHaveLength(countBefore);
    });
  });

  // -------------------------------------------------------------------------
  // Complex end-to-end scenarios
  // -------------------------------------------------------------------------
  describe('complex end-to-end scenarios', () => {
    it('full lifecycle: greet -> tool -> stop -> retry -> escalate -> agent chat -> resolve', () => {
      const state = createWorkflow();

      // 1. Greeting
      simulateUserMessage(state, 'Hi, I need help with my order', makeLLMResult({ fullText: 'Of course! What is your order number?' }));

      // 2. Tool use
      simulateUserMessage(
        state,
        'Order 12345',
        makeToolUseLLM('doResearch', { query: 'order 12345' }),
        { orderId: '12345', status: 'delayed', reason: 'weather' },
        makeLLMResult({ fullText: 'Your order 12345 is delayed due to weather.' })
      );

      // 3. Stop mid-response — checkpoint keeps user msg
      simulateUserMessage(state, 'Actually never mind that', makeLLMResult({ cancelled: true }));

      // 4. New question, successful
      simulateUserMessage(state, 'I want a refund instead', makeLLMResult({ fullText: 'I understand. Let me connect you with our team.' }));

      // 5. Escalation
      simulateUserMessage(state, 'Yes, please escalate', makeEscalateLLM('Refund request requires human approval'));
      expect(state.status).toBe('escalated');

      // 6. Customer message during escalation (triggers notifyHumanAgent)
      simulateUserMessage(state, 'How long will this take?');

      // 7. Agent joins and chats
      simulateAgentDecision(state, { action: 'respond', message: 'Hi! Processing your refund now.' }, true);
      simulateUserMessage(state, 'Thank you');
      simulateAgentDecision(state, { action: 'respond', message: 'Done -- $50 refund issued.' }, false);

      // 8. Resolve
      simulateAgentDecision(state, { action: 'resolve', message: 'Anything else?' }, false);
      expect(state.status).toBe('resolved');

      // Validate the conversation
      assertNoOrphanedToolCalls(state.messages);

      // Verify no empty assistant messages (tool_use can have empty fullText but must have rawContentBlocks)
      state.messages
        .filter((m) => m.role === 'assistant')
        .forEach((m) => {
          if (!m.content) {
            expect(m.rawContentBlocks).toBeDefined();
            expect(m.rawContentBlocks!.length).toBeGreaterThan(0);
          }
        });
    });

    it('stop during tool -> new message -> tool -> stop follow-up -> success', () => {
      const state = createWorkflow();

      simulateUserMessage(state, 'Hello', makeLLMResult({ fullText: 'Hi!' }));

      // Tool cancelled
      simulateUserMessage(
        state,
        'Research A',
        makeToolUseLLM('doResearch', { query: 'A' }),
        { cancelled: true }
      );

      // Normal text response
      simulateUserMessage(state, 'Just tell me about B', makeLLMResult({ fullText: 'B is great.' }));

      // Tool succeeds but follow-up cancelled
      simulateUserMessage(
        state,
        'Now research C',
        makeToolUseLLM('doResearch', { query: 'C' }),
        { results: ['C data'] },
        makeLLMResult({ cancelled: true })
      );

      // Final success with tool
      simulateUserMessage(
        state,
        'Research D',
        makeToolUseLLM('doResearch', { query: 'D' }),
        { results: ['D data'] },
        makeLLMResult({ fullText: 'D findings are...' })
      );

      assertNoOrphanedToolCalls(state.messages);
    });

    it('handback -> stop -> tool -> escalate -> resolve', () => {
      const state = createWorkflow();

      // AI greets
      simulateUserMessage(state, 'Hi', makeLLMResult({ fullText: 'Hello!' }));

      // Escalate
      simulateUserMessage(state, 'Human', makeEscalateLLM('Wants human'));

      // Agent hands back quickly
      simulateAgentDecision(state, { action: 'handback' }, true);
      expect(state.status).toBe('active');

      // Stop during AI response — checkpoint keeps user msg
      simulateUserMessage(state, 'Long q...', makeLLMResult({ cancelled: true }));

      // Tool use succeeds
      simulateUserMessage(
        state,
        'Check order 50',
        makeToolUseLLM('lookupOrder', { orderId: '50' }),
        { orderId: '50', status: 'cancelled' },
        makeLLMResult({ fullText: 'That order was cancelled.' })
      );

      // Second escalation
      simulateUserMessage(state, 'Why was it cancelled!?', makeEscalateLLM('Angry customer'));
      expect(state.status).toBe('escalated');

      // Resolve
      simulateAgentDecision(state, { action: 'resolve', message: 'Refund processed.' }, true);
      expect(state.status).toBe('resolved');

      assertNoOrphanedToolCalls(state.messages);
    });
  });

  // -------------------------------------------------------------------------
  // Invariant checks
  // -------------------------------------------------------------------------
  describe('message history invariants', () => {
    it('never has orphaned tool_use without tool result', () => {
      const state = createWorkflow();

      // Tool cancelled
      simulateUserMessage(
        state,
        'Do something',
        makeToolUseLLM('doThing', {}),
        { cancelled: true }
      );

      // Normal turn
      simulateUserMessage(state, 'Try again', makeLLMResult({ fullText: 'OK' }));

      assertNoOrphanedToolCalls(state.messages);
    });

    it('step calls are tracked correctly for a full escalation', () => {
      const state = createWorkflow();

      simulateUserMessage(state, 'Help', makeLLMResult({ fullText: 'Sure' }));
      simulateUserMessage(state, 'Human', makeEscalateLLM('Needs human'));
      simulateAgentDecision(state, { action: 'respond', message: 'On it.' }, true);
      simulateAgentDecision(state, { action: 'resolve' }, false);

      const stepNames = state.calls.map((c) => c.step);
      expect(stepNames).toContain('publishUserMessage');
      expect(stepNames).toContain('publishEscalation');
      expect(stepNames).toContain('notifyHumanAgent');
      expect(stepNames).toContain('updateEscalationStatus');
      expect(stepNames).toContain('publishAgentMessage');

      // updateEscalationStatus called twice: 'responding' then 'resolved'
      const statusCalls = state.calls.filter((c) => c.step === 'updateEscalationStatus');
      expect(statusCalls).toHaveLength(2);
      expect(statusCalls[0].args?.status).toBe('responding');
      expect(statusCalls[1].args?.status).toBe('resolved');
    });
  });
});
