import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @anthropic-ai/sdk before importing classifyIntent
const { mockCreate } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  return { mockCreate };
});

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
      constructor() { /* noop */ }
    },
  };
});

import { classifyIntent } from '@/lib/classify-intent';

function mockResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
  };
}

describe('classifyIntent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('returns "steer" when Claude says steer', async () => {
    mockCreate.mockResolvedValueOnce(mockResponse('steer'));
    const result = await classifyIntent('actually check order 5678', 'Looking up order 1234');
    expect(result).toBe('steer');
  });

  it('returns "double-text" when Claude says double-text', async () => {
    mockCreate.mockResolvedValueOnce(mockResponse('double-text'));
    const result = await classifyIntent('also check my refund', 'Looking up order 1234');
    expect(result).toBe('double-text');
  });

  it('returns "stop" when Claude says stop', async () => {
    mockCreate.mockResolvedValueOnce(mockResponse('stop'));
    const result = await classifyIntent('cancel', 'Looking up order 1234');
    expect(result).toBe('stop');
  });

  it('returns "steer" as fallback for unknown responses', async () => {
    mockCreate.mockResolvedValueOnce(mockResponse('something unexpected'));
    const result = await classifyIntent('hello', 'some task');
    expect(result).toBe('steer');
  });

  it('returns "steer" when API key is not set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await classifyIntent('hello', 'some task');
    expect(result).toBe('steer');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns "steer" on API error', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API error'));
    const result = await classifyIntent('hello', 'some task');
    expect(result).toBe('steer');
  });

  it('handles "double_text" variant', async () => {
    mockCreate.mockResolvedValueOnce(mockResponse('double_text'));
    const result = await classifyIntent('by the way, check order 9999', 'Looking up order 1234');
    expect(result).toBe('double-text');
  });

  it('handles "doubletext" variant', async () => {
    mockCreate.mockResolvedValueOnce(mockResponse('doubletext'));
    const result = await classifyIntent('while you do that, check refund', 'Looking up order 1234');
    expect(result).toBe('double-text');
  });

  it('uses claude-haiku-4-5-20251001 model', async () => {
    mockCreate.mockResolvedValueOnce(mockResponse('steer'));
    await classifyIntent('test', 'task');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
      expect.anything()
    );
  });
});
