import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the Temporal steer API route (/api/sessions/[id]/steer).
 *
 * The Temporal steer route uses dual delivery for stop/steer:
 * 1. Ephemeral Ably message for instant pickup (~50ms)
 * 2. Temporal signal (steerGeneration) as durable safety net
 *
 * For newMessage: classifies intent, then routes to steer, double-text, or stop.
 */

// --- Mocks ---
const { mockPublish, mockChannelsGet, mockSignal, mockGetHandle, mockStart, mockClassifyIntent } = vi.hoisted(() => {
  const mockPublish = vi.fn().mockResolvedValue(undefined);
  const mockChannelsGet = vi.fn().mockReturnValue({ publish: mockPublish });
  const mockSignal = vi.fn().mockResolvedValue(undefined);
  const mockGetHandle = vi.fn().mockReturnValue({ signal: mockSignal });
  const mockStart = vi.fn().mockResolvedValue(undefined);
  const mockClassifyIntent = vi.fn().mockResolvedValue('steer');
  return { mockPublish, mockChannelsGet, mockSignal, mockGetHandle, mockStart, mockClassifyIntent };
});

vi.mock('ably', () => {
  function MockRest() {
    return { channels: { get: mockChannelsGet } };
  }
  return { default: { Rest: MockRest } };
});

vi.mock('@/lib/temporal-client', () => ({
  getTemporalClient: vi.fn().mockResolvedValue({
    workflow: {
      getHandle: mockGetHandle,
      start: mockStart,
    },
  }),
  TASK_QUEUE: 'support-copilot',
}));

vi.mock('@/lib/classify-intent', () => ({
  classifyIntent: mockClassifyIntent,
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
    mockChannelsGet.mockReturnValue({ publish: mockPublish });
    mockGetHandle.mockReturnValue({ signal: mockSignal });
    mockPublish.mockResolvedValue(undefined);
    mockSignal.mockResolvedValue(undefined);
    mockStart.mockResolvedValue(undefined);
    mockClassifyIntent.mockResolvedValue('steer');
    process.env.ABLY_API_KEY = 'test-app.test-key:test-secret';
  });

  describe('stop action', () => {
    it('publishes ephemeral control message AND signals Temporal workflow', async () => {
      const res = await POST(makeRequest({ action: 'stop' }), { params });
      expect(res.status).toBe(200);

      expect(mockPublish).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'control',
          data: JSON.stringify({ action: 'stop' }),
          extras: { ephemeral: true },
        })
      );

      expect(mockGetHandle).toHaveBeenCalledWith('support-test-session');
      expect(mockSignal).toHaveBeenCalledWith('steerGeneration', { action: 'stop' });
    });
  });

  describe('newMessage action — steer intent', () => {
    it('publishes user message, classifies intent, then steers', async () => {
      mockClassifyIntent.mockResolvedValueOnce('steer');

      const res = await POST(
        makeRequest({
          action: 'newMessage',
          text: 'Track order 127',
          messageId: 'msg_127',
          currentTaskSummary: 'Looking up order 456',
        }),
        { params }
      );
      expect(res.status).toBe(200);

      // Should publish user message first, then control message
      expect(mockPublish).toHaveBeenCalledTimes(2);
      expect(mockPublish).toHaveBeenNthCalledWith(1,
        expect.objectContaining({
          id: 'msg_127',
          name: 'user',
          data: 'Track order 127',
        })
      );
      expect(mockPublish).toHaveBeenNthCalledWith(2,
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

      // Should NOT start a one-shot workflow
      expect(mockStart).not.toHaveBeenCalled();
    });
  });

  describe('newMessage action — double-text intent', () => {
    it('publishes user message, ack, and starts one-shot workflow', async () => {
      mockClassifyIntent.mockResolvedValueOnce('double-text');

      const res = await POST(
        makeRequest({
          action: 'newMessage',
          text: 'Also check my refund status',
          messageId: 'msg_456',
          currentTaskSummary: 'Looking up order 123',
        }),
        { params }
      );
      expect(res.status).toBe(200);

      // Should publish user message + ack response
      expect(mockPublish).toHaveBeenCalledTimes(2);
      expect(mockPublish).toHaveBeenNthCalledWith(1,
        expect.objectContaining({
          id: 'msg_456',
          name: 'user',
          data: 'Also check my refund status',
        })
      );
      expect(mockPublish).toHaveBeenNthCalledWith(2,
        expect.objectContaining({
          name: 'response',
          extras: expect.objectContaining({
            headers: expect.objectContaining({
              status: 'complete',
              source: 'system-ack',
            }),
          }),
        })
      );

      // Should start a one-shot workflow
      expect(mockStart).toHaveBeenCalledWith('oneShotWorkflow', expect.objectContaining({
        taskQueue: 'support-copilot',
      }));

      // Should NOT signal the primary workflow
      expect(mockSignal).not.toHaveBeenCalled();
    });
  });

  describe('newMessage action — stop intent', () => {
    it('publishes user message, then stops', async () => {
      mockClassifyIntent.mockResolvedValueOnce('stop');

      const res = await POST(
        makeRequest({
          action: 'newMessage',
          text: 'never mind, cancel',
          messageId: 'msg_789',
        }),
        { params }
      );
      expect(res.status).toBe(200);

      // User message + control stop
      expect(mockPublish).toHaveBeenCalledTimes(2);
      expect(mockPublish).toHaveBeenNthCalledWith(2,
        expect.objectContaining({
          name: 'control',
          data: JSON.stringify({ action: 'stop' }),
          extras: { ephemeral: true },
        })
      );

      expect(mockSignal).toHaveBeenCalledWith('steerGeneration', { action: 'stop' });
    });
  });

  describe('newMessage validation', () => {
    it('requires text and messageId', async () => {
      const res = await POST(
        makeRequest({ action: 'newMessage' }),
        { params }
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('text and messageId required');
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
