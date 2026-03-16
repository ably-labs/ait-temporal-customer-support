import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the Temporal steer API route (/api/sessions/[id]/steer).
 *
 * The Temporal steer route uses dual delivery:
 * 1. Ephemeral Ably message for instant pickup (~50ms)
 * 2. Temporal signal (steerGeneration) as durable safety net
 *
 * Unlike the Vercel WDK version which uses resumeHook, this route uses
 * Temporal's signal mechanism via client.workflow.getHandle().signal().
 */

// --- Mocks ---
// Use vi.hoisted to create mock functions that can be referenced inside vi.mock factories

const { mockPublish, mockChannelsGet, mockSignal, mockGetHandle, mockClassifyIntent, mockWorkflowStart } = vi.hoisted(() => {
  const mockPublish = vi.fn().mockResolvedValue(undefined);
  const mockChannelsGet = vi.fn().mockReturnValue({ publish: mockPublish });
  const mockSignal = vi.fn().mockResolvedValue(undefined);
  const mockGetHandle = vi.fn().mockReturnValue({ signal: mockSignal });
  const mockClassifyIntent = vi.fn().mockResolvedValue('steer');
  const mockWorkflowStart = vi.fn().mockResolvedValue(undefined);
  return { mockPublish, mockChannelsGet, mockSignal, mockGetHandle, mockClassifyIntent, mockWorkflowStart };
});

vi.mock('ably', () => {
  function MockRest() {
    return { channels: { get: mockChannelsGet } };
  }
  return { default: { Rest: MockRest } };
});

vi.mock('@/lib/temporal-client', () => ({
  getTemporalClient: vi.fn().mockResolvedValue({
    workflow: { getHandle: mockGetHandle, start: mockWorkflowStart },
  }),
  TASK_QUEUE: 'support-copilot',
}));

vi.mock('@/lib/classify-intent', () => ({
  classifyIntent: (...args: unknown[]) => mockClassifyIntent(...args),
}));

// Must import AFTER mocks are set up
import { POST } from '@/app/api/sessions/[id]/steer/route';
import { NextRequest } from 'next/server';

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/sessions/test-session/steer', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const params = Promise.resolve({ id: 'test-session' });

describe('Steer API route (Temporal)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-setup default return values after clearAllMocks
    mockChannelsGet.mockReturnValue({ publish: mockPublish });
    mockGetHandle.mockReturnValue({ signal: mockSignal });
    mockPublish.mockResolvedValue(undefined);
    mockSignal.mockResolvedValue(undefined);
    mockClassifyIntent.mockResolvedValue('steer');
    mockWorkflowStart.mockResolvedValue(undefined);
    process.env.ABLY_API_KEY = 'test-app.test-key:test-secret';
  });

  describe('stop action', () => {
    it('publishes ephemeral control message AND signals Temporal workflow', async () => {
      const res = await POST(makeRequest({ action: 'stop' }), { params });
      expect(res.status).toBe(200);

      // Should publish exactly one Ably message: the control message
      expect(mockPublish).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'control',
          data: JSON.stringify({ action: 'stop', text: undefined }),
          extras: { ephemeral: true },
        })
      );

      // Should also signal the Temporal workflow
      expect(mockGetHandle).toHaveBeenCalledWith('support-test-session');
      expect(mockSignal).toHaveBeenCalledWith('steerGeneration', {
        action: 'stop',
        text: undefined,
        messageId: undefined,
      });
    });
  });

  describe('newMessage action', () => {
    it('publishes user message + control message and signals Temporal when intent is steer', async () => {
      mockClassifyIntent.mockResolvedValue('steer');
      const res = await POST(
        makeRequest({
          action: 'newMessage',
          text: 'Track order 127',
          messageId: 'msg_127',
        }),
        { params }
      );
      expect(res.status).toBe(200);

      // Should publish one Ably message: ephemeral control
      // (user message is published by the Temporal workflow's publishUserMessage activity)
      expect(mockPublish).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'control',
          data: JSON.stringify({ action: 'newMessage', text: 'Track order 127' }),
          extras: { ephemeral: true },
        })
      );

      // Should signal the Temporal workflow
      expect(mockSignal).toHaveBeenCalledWith('steerGeneration', {
        action: 'newMessage',
        text: 'Track order 127',
        messageId: 'msg_127',
      });

      // Should have classified intent
      expect(mockClassifyIntent).toHaveBeenCalledWith('Track order 127', '');
    });

    it('starts a one-shot workflow when intent is double-text', async () => {
      mockClassifyIntent.mockResolvedValue('double-text');
      const res = await POST(
        makeRequest({
          action: 'newMessage',
          text: 'Also check my refund',
          messageId: 'msg_128',
        }),
        { params }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.intent).toBe('double-text');
      expect(body.taskId).toBeDefined();

      // Should publish user message but NOT control message
      expect(mockPublish).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'user', data: 'Also check my refund' })
      );

      // Should NOT signal the main workflow
      expect(mockSignal).not.toHaveBeenCalled();

      // Should start a one-shot workflow
      expect(mockWorkflowStart).toHaveBeenCalledWith(
        'oneShotWorkflow',
        expect.objectContaining({
          taskQueue: 'support-copilot',
          args: expect.arrayContaining(['test-session', expect.any(String), 'Also check my refund']),
        })
      );
    });

    it('sends stop signal when intent is classified as stop', async () => {
      mockClassifyIntent.mockResolvedValue('stop');
      const res = await POST(
        makeRequest({
          action: 'newMessage',
          text: 'never mind, stop',
          messageId: 'msg_129',
        }),
        { params }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.intent).toBe('stop');

      // Should publish control stop message only
      // (no user message — the workflow handles that)
      expect(mockPublish).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'control',
          data: JSON.stringify({ action: 'stop', text: 'never mind, stop' }),
          extras: { ephemeral: true },
        })
      );

      // Should signal stop to Temporal
      expect(mockSignal).toHaveBeenCalledWith('steerGeneration', {
        action: 'stop',
        text: 'never mind, stop',
        messageId: 'msg_129',
      });
    });
  });

  describe('validation', () => {
    it('rejects invalid actions', async () => {
      const res = await POST(
        makeRequest({ action: 'invalid' }),
        { params }
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('action must be');
    });

    it('rejects missing action', async () => {
      const res = await POST(
        makeRequest({}),
        { params }
      );
      expect(res.status).toBe(400);
    });

    it('requires ABLY_API_KEY', async () => {
      delete process.env.ABLY_API_KEY;
      const res = await POST(
        makeRequest({ action: 'stop' }),
        { params }
      );
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain('ABLY_API_KEY');
    });
  });

  describe('Temporal signal failure handling', () => {
    it('still returns 200 if Temporal signal fails (workflow may be done)', async () => {
      mockSignal.mockRejectedValueOnce(new Error('Workflow not found'));

      const res = await POST(makeRequest({ action: 'stop' }), { params });
      expect(res.status).toBe(200);

      // Ably message was still published
      expect(mockPublish).toHaveBeenCalledTimes(1);
    });
  });
});
