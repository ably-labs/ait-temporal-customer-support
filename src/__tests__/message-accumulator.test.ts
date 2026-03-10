import { describe, it, expect } from 'vitest';
import { MessageAccumulator } from '@/lib/message-accumulator';

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    serial: 'serial-1',
    name: 'response',
    data: 'hello',
    action: 'message.create',
    clientId: undefined,
    extras: undefined,
    ...overrides,
  } as unknown as import('ably').Message;
}

describe('MessageAccumulator', () => {
  it('returns null for messages without a serial', () => {
    const acc = new MessageAccumulator();
    const result = acc.apply({ data: 'test' } as unknown as import('ably').Message);
    expect(result).toBeNull();
  });

  it('creates a new message on message.create', () => {
    const acc = new MessageAccumulator();
    const result = acc.apply(makeMessage({ serial: 's1', data: 'Hello' }));
    expect(result).not.toBeNull();
    expect(result!.serial).toBe('s1');
    expect(result!.data).toBe('Hello');
    expect(result!.name).toBe('response');
    expect(result!.isComplete).toBe(false);
  });

  it('appends data on message.append', () => {
    const acc = new MessageAccumulator();
    acc.apply(makeMessage({ serial: 's1', data: 'Hello' }));
    const result = acc.apply(makeMessage({ serial: 's1', data: ' world', action: 'message.append' }));
    expect(result!.data).toBe('Hello world');
  });

  it('handles append without prior create', () => {
    const acc = new MessageAccumulator();
    const result = acc.apply(makeMessage({ serial: 's1', data: 'orphan', action: 'message.append' }));
    expect(result!.data).toBe('orphan');
  });

  it('replaces data on message.update', () => {
    const acc = new MessageAccumulator();
    acc.apply(makeMessage({ serial: 's1', data: 'original' }));
    const result = acc.apply(makeMessage({ serial: 's1', data: 'replaced', action: 'message.update' }));
    expect(result!.data).toBe('replaced');
  });

  it('preserves data on update with empty string', () => {
    const acc = new MessageAccumulator();
    acc.apply(makeMessage({ serial: 's1', data: 'keep me' }));
    const result = acc.apply(makeMessage({ serial: 's1', data: '', action: 'message.update' }));
    // Empty string is falsy, so data is preserved
    expect(result!.data).toBe('keep me');
  });

  it('detects terminal status "complete"', () => {
    const acc = new MessageAccumulator();
    acc.apply(makeMessage({ serial: 's1', data: 'text' }));
    const result = acc.apply(makeMessage({
      serial: 's1',
      data: '',
      action: 'message.update',
      extras: { headers: { status: 'complete' } },
    }));
    expect(result!.isComplete).toBe(true);
  });

  it('detects terminal status "stopped"', () => {
    const acc = new MessageAccumulator();
    acc.apply(makeMessage({ serial: 's1', data: 'partial' }));
    const result = acc.apply(makeMessage({
      serial: 's1',
      data: '',
      action: 'message.update',
      extras: { headers: { status: 'stopped' } },
    }));
    expect(result!.isComplete).toBe(true);
  });

  it('tracks multiple messages by serial independently', () => {
    const acc = new MessageAccumulator();
    acc.apply(makeMessage({ serial: 's1', data: 'msg1' }));
    acc.apply(makeMessage({ serial: 's2', data: 'msg2' }));
    const r1 = acc.apply(makeMessage({ serial: 's1', data: '+', action: 'message.append' }));
    const r2 = acc.apply(makeMessage({ serial: 's2', data: '!', action: 'message.append' }));
    expect(r1!.data).toBe('msg1+');
    expect(r2!.data).toBe('msg2!');
  });

  it('returns null for unknown action types', () => {
    const acc = new MessageAccumulator();
    const result = acc.apply(makeMessage({ serial: 's1', action: 'message.delete' }));
    expect(result).toBeNull();
  });
});
