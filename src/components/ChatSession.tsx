'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useChannel } from 'ably/react';
import type Ably from 'ably';
import { MessageAccumulator } from '@/lib/message-accumulator';

interface ChatMessage {
  id: string; // serial for confirmed messages, optimistic-{ts} for pending
  role: 'user' | 'assistant';
  content: string;
  isStreaming: boolean;
}

interface Props {
  sessionId: string;
}

export default function ChatSession({ sessionId }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const channelName = `ai:support:${sessionId}`;

  // Accumulator handles message materialisation — one instance for the component lifetime
  const [accumulator] = useState(() => new MessageAccumulator());

  const handleAblyMessage = useCallback(
    (message: Ably.Message) => {
      const result = accumulator.apply(message);
      if (!result) return;

      const { serial, name } = result;
      // Keep raw message reference for accessing .id (client-generated message ID)

      if (name === 'user') {
        // User message echoed from Ably — match optimistic message by the
        // client-generated message ID (passed through API → Temporal → Ably)
        const ablyMessageId = (message as Ably.Message).id;
        setMessages((prev) => {
          const existing = prev.find((m) => m.id === serial);
          if (existing) return prev;
          // Match optimistic message by the shared messageId
          const optimisticIdx = ablyMessageId
            ? prev.findIndex((m) => m.id === ablyMessageId)
            : -1;
          if (optimisticIdx >= 0) {
            const updated = [...prev];
            updated[optimisticIdx] = { ...updated[optimisticIdx], id: serial };
            return updated;
          }
          return [
            ...prev,
            { id: serial, role: 'user', content: result.data, isStreaming: false },
          ];
        });
        return;
      }

      if (name === 'response') {
        setMessages((prev) => {
          const existing = prev.find((m) => m.id === serial);
          if (existing) {
            // Update in place with the materialised content from the accumulator
            return prev.map((m) =>
              m.id === serial
                ? { ...m, content: result.data, isStreaming: !result.isComplete }
                : m
            );
          }
          // New message (create or late-join update from history)
          return [
            ...prev,
            {
              id: serial,
              role: 'assistant',
              content: result.data,
              isStreaming: !result.isComplete,
            },
          ];
        });
      }
    },
    [accumulator]
  );

  // Subscribe to the Ably channel (rewind configured via ChannelProvider)
  useChannel(channelName, (message: Ably.Message) => {
    handleAblyMessage(message);
  });

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;

    // Generate a deterministic message ID used for both optimistic UI and Ably publish.
    // The same ID flows: frontend → API → Temporal signal → activity → Ably message.id
    // On the echo, we match by this ID instead of by content.
    const messageId = `user_${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Optimistic UI — show immediately, keyed by messageId
    setMessages((prev) => [
      ...prev,
      { id: messageId, role: 'user', content: text, isStreaming: false },
    ]);
    setInput('');
    setSending(true);

    try {
      const res = await fetch(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, messageId }),
      });
      if (!res.ok) {
        const err = await res.json();
        console.error('Failed to send message:', err);
      }
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <p className="text-center text-zinc-400 mt-8">
            Send a message to start the conversation.
          </p>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[75%] rounded-xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-zinc-100 dark:bg-zinc-800 text-foreground'
              }`}
            >
              {msg.content}
              {msg.isStreaming && (
                <span className="inline-block w-1.5 h-4 ml-0.5 bg-current opacity-60 animate-pulse" />
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t border-zinc-200 dark:border-zinc-700 p-4">
        <div className="flex gap-2 max-w-3xl mx-auto">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-transparent px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            disabled={sending}
          />
          <button
            onClick={sendMessage}
            disabled={sending || !input.trim()}
            className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
