/**
 * MessageAccumulator: stateful helper that materialises Ably message operations
 * into complete message objects.
 *
 * The Ably SDK delivers message.append events as fragments (just the appended data),
 * leaving the developer to maintain accumulated state. This is efficient on the wire
 * (each event is tiny), but pushes assembly logic onto every consumer.
 *
 * This helper fills that gap: feed it raw Ably messages and it emits the full
 * materialised message each time. It handles create, append, and update actions,
 * keyed by message serial.
 *
 * NOTE: We think this pattern is common enough (especially for AI token streaming)
 * that it could be offered as a built-in SDK helper in future — something like
 * `channel.subscribeAccumulated(callback)` that emits materialised messages
 * instead of raw operations. The logic is simple, but it's still boilerplate
 * that every developer using message-per-response will write.
 */

import type Ably from 'ably';

export interface AccumulatedMessage {
  serial: string;
  name: string;
  data: string;
  clientId?: string;
  extras?: Record<string, unknown>;
  action: string;
  /** True if this message has received a completion signal */
  isComplete: boolean;
}

type Listener = (message: AccumulatedMessage) => void;

export class MessageAccumulator {
  private messages = new Map<string, AccumulatedMessage>();
  private listeners: Listener[] = [];

  /**
   * Process a raw Ably message. Call this from channel.subscribe().
   * The accumulator updates internal state and notifies listeners
   * with the full materialised message.
   */
  apply(message: Ably.Message): AccumulatedMessage | null {
    const serial = message.serial;
    if (!serial) return null;

    const data = typeof message.data === 'string' ? message.data : '';
    const action = message.action ?? 'message.create';
    const isComplete =
      (message.extras?.headers as Record<string, string>)?.status === 'complete';

    let accumulated: AccumulatedMessage;

    switch (action) {
      case 'message.create': {
        accumulated = {
          serial,
          name: message.name ?? '',
          data,
          clientId: message.clientId ?? undefined,
          extras: message.extras as Record<string, unknown> | undefined,
          action,
          isComplete,
        };
        this.messages.set(serial, accumulated);
        break;
      }

      case 'message.append': {
        const existing = this.messages.get(serial);
        if (existing) {
          existing.data += data;
          existing.action = action;
          if (isComplete) existing.isComplete = true;
          accumulated = existing;
        } else {
          // Append without a prior create (e.g. missed the create event)
          accumulated = {
            serial,
            name: message.name ?? '',
            data,
            clientId: message.clientId ?? undefined,
            extras: message.extras as Record<string, unknown> | undefined,
            action,
            isComplete,
          };
          this.messages.set(serial, accumulated);
        }
        break;
      }

      case 'message.update': {
        const existing = this.messages.get(serial);
        if (existing) {
          // Update replaces data if provided, preserves if not (shallow mixin)
          if (data) existing.data = data;
          if (message.extras) {
            existing.extras = message.extras as Record<string, unknown>;
          }
          existing.action = action;
          if (isComplete) existing.isComplete = true;
          accumulated = existing;
        } else {
          // Update without prior create (history/rewind delivers updates)
          accumulated = {
            serial,
            name: message.name ?? '',
            data,
            clientId: message.clientId ?? undefined,
            extras: message.extras as Record<string, unknown> | undefined,
            action,
            isComplete,
          };
          this.messages.set(serial, accumulated);
        }
        break;
      }

      default:
        return null;
    }

    // Notify listeners with the full materialised message
    for (const listener of this.listeners) {
      listener(accumulated);
    }

    return accumulated;
  }

  /** Subscribe to materialised message updates */
  on(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Get the current materialised state of a message by serial */
  get(serial: string): AccumulatedMessage | undefined {
    return this.messages.get(serial);
  }

  /** Get all materialised messages */
  getAll(): AccumulatedMessage[] {
    return Array.from(this.messages.values());
  }

  /** Clear all state */
  clear(): void {
    this.messages.clear();
  }
}
