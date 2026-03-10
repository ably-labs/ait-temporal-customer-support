'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useChannel } from 'ably/react';
import { ChannelProvider } from 'ably/react';
import type Ably from 'ably';
import Link from 'next/link';
import { MessageAccumulator } from '@/lib/message-accumulator';

interface Escalation {
  id: string;
  sessionId: string;
  customerName: string;
  reason: string;
  messageCount: number;
  timestamp: number;
  status: 'pending' | 'responding' | 'resolved' | 'dismissed';
}

interface ConversationMessage {
  id: string;
  type: 'text' | 'tool' | 'escalation';
  role: 'user' | 'assistant' | 'system';
  content: string;
  isStreaming: boolean;
  source?: string; // 'human-agent' for human agent messages
}

/**
 * Inline conversation viewer for a single escalated session.
 * Subscribes to the session's Ably channel with rewind to show history.
 */
function SessionConversation({ sessionId }: { sessionId: string }) {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [accumulator] = useState(() => new MessageAccumulator());
  const channelName = `ai:support:${sessionId}`;

  const handleMessage = useCallback(
    (message: Ably.Message) => {
      const result = accumulator.apply(message);
      if (!result) return;

      const { serial, name } = result;
      const source = (result.extras?.headers as Record<string, string>)?.source;

      if (name === 'user') {
        setMessages((prev) => {
          if (prev.find((m) => m.id === serial)) return prev;
          return [
            ...prev,
            { id: serial, type: 'text', role: 'user', content: result.data, isStreaming: false },
          ];
        });
        return;
      }

      if (name === 'response') {
        setMessages((prev) => {
          const existing = prev.find((m) => m.id === serial);
          if (existing) {
            return prev.map((m) =>
              m.id === serial
                ? { ...m, content: result.data, isStreaming: !result.isComplete, source }
                : m
            );
          }
          return [
            ...prev,
            {
              id: serial,
              type: 'text',
              role: 'assistant',
              content: result.data,
              isStreaming: !result.isComplete,
              source,
            },
          ];
        });
        return;
      }

      if (name === 'tool') {
        // Show tool calls as compact system messages
        let toolName = 'tool';
        try {
          const parsed = JSON.parse(result.data);
          toolName = parsed.toolName || 'tool';
        } catch { /* ignore */ }
        setMessages((prev) => {
          if (prev.find((m) => m.id === serial)) {
            return prev.map((m) =>
              m.id === serial ? { ...m, content: result.data } : m
            );
          }
          return [
            ...prev,
            { id: serial, type: 'tool', role: 'system', content: toolName, isStreaming: false },
          ];
        });
        return;
      }

      if (name === 'escalation') {
        setMessages((prev) => {
          if (prev.find((m) => m.id === serial)) return prev;
          return [
            ...prev,
            { id: serial, type: 'escalation', role: 'system', content: result.data, isStreaming: false },
          ];
        });
      }
    },
    [accumulator]
  );

  useChannel(channelName, (message: Ably.Message) => {
    handleMessage(message);
  });

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="max-h-64 overflow-y-auto border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 p-3 space-y-2">
      {messages.length === 0 && (
        <p className="text-xs text-zinc-400 text-center py-4">Loading conversation...</p>
      )}
      {messages.map((msg) => {
        if (msg.type === 'tool') {
          return (
            <div key={msg.id} className="text-xs text-zinc-400 italic px-2">
              Tool: {msg.content}
            </div>
          );
        }
        if (msg.type === 'escalation') {
          return (
            <div key={msg.id} className="text-xs text-center text-amber-600 dark:text-amber-400 py-1">
              {msg.content}
            </div>
          );
        }
        const isUser = msg.role === 'user';
        const isHumanAgent = msg.source === 'human-agent';
        return (
          <div key={msg.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[80%] rounded-lg px-3 py-1.5 text-xs leading-relaxed ${
                isUser
                  ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-900 dark:text-blue-100'
                  : isHumanAgent
                    ? 'bg-green-100 dark:bg-green-900/30 text-green-900 dark:text-green-100 border border-green-200 dark:border-green-800'
                    : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
              }`}
            >
              {isHumanAgent && (
                <span className="text-[10px] font-medium text-green-600 dark:text-green-400 block mb-0.5">
                  You (Agent)
                </span>
              )}
              <span className="whitespace-pre-wrap">{msg.content}</span>
              {msg.isStreaming && (
                <span className="inline-block w-1 h-3 ml-0.5 bg-current opacity-60 animate-pulse" />
              )}
            </div>
          </div>
        );
      })}
      <div ref={scrollRef} />
    </div>
  );
}

// Max sessions to auto-attach Ably channels for — keeps channel count bounded.
// Older sessions show a manual "Show conversation" toggle instead.
const MAX_AUTO_ATTACH = 20;

function EscalationList() {
  const [escalations, setEscalations] = useState<Escalation[]>([]);
  // Sessions manually expanded by the agent (for those beyond the auto-attach limit)
  const [manuallyExpanded, setManuallyExpanded] = useState<Set<string>>(new Set());
  const [responseText, setResponseText] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<Record<string, boolean>>({});

  useChannel('ai:agent:escalations', (message: Ably.Message) => {
    if (message.name === 'escalation' && message.data) {
      let data: Record<string, unknown>;
      try {
        data = typeof message.data === 'string' ? JSON.parse(message.data) : message.data;
      } catch {
        return;
      }

      // Status-only update (from updateEscalationStatus activity)
      if (data.status && !data.customerName) {
        const updateStatus = data.status as Escalation['status'];
        const updateSessionId = data.sessionId as string;
        setEscalations((prev) =>
          prev.map((e) =>
            e.sessionId === updateSessionId ? { ...e, status: updateStatus } : e
          )
        );
        return;
      }

      // Full escalation message
      const sessionId = data.sessionId as string;
      const status = (data.status as Escalation['status']) ?? 'pending';
      setEscalations((prev) => {
        // Dedup by sessionId — update status if already exists
        const existing = prev.find((e) => e.sessionId === sessionId);
        if (existing) {
          return prev.map((e) =>
            e.sessionId === sessionId ? { ...e, status } : e
          );
        }
        return [
          {
            id: message.serial ?? `esc-${Date.now()}`,
            sessionId,
            customerName: data.customerName as string,
            reason: data.reason as string,
            messageCount: data.messageCount as number,
            timestamp: Date.now(),
            status,
          },
          ...prev,
        ];
      });
    }
  });

  const dismiss = async (escalation: Escalation) => {
    try {
      const res = await fetch('/api/escalations/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serial: escalation.id, sessionId: escalation.sessionId }),
      });
      if (!res.ok) {
        console.error('Failed to dismiss:', await res.text());
      }
      // Status update will arrive via Ably mutable message
    } catch (err) {
      console.error('Failed to dismiss:', err);
    }
  };

  const respond = async (sessionId: string, action: 'respond' | 'resolve') => {
    const text = responseText[sessionId]?.trim();
    if (!text) return;

    setSending((prev) => ({ ...prev, [sessionId]: true }));

    try {
      const res = await fetch(`/api/sessions/${sessionId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, message: text }),
      });

      if (res.ok) {
        // Status update will arrive via Ably mutable message from Temporal workflow
        setResponseText((prev) => ({ ...prev, [sessionId]: '' }));
      }
    } catch (err) {
      console.error('Failed to respond:', err);
    } finally {
      setSending((prev) => ({ ...prev, [sessionId]: false }));
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Escalated Sessions</h1>
        <Link
          href="/"
          className="text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400"
        >
          Customer view
        </Link>
      </div>

      {escalations.filter((e) => e.status !== 'dismissed' && e.status !== 'resolved').length === 0 && (
        <div className="text-center py-12 text-zinc-400">
          <p className="text-lg">No escalations yet</p>
          <p className="text-sm mt-1">Waiting for escalated sessions...</p>
        </div>
      )}

      {escalations.filter((e) => e.status !== 'dismissed' && e.status !== 'resolved').map((esc, index) => {
        // Auto-attach conversation channels for the most recent N sessions.
        // Older sessions require manual expand to avoid hitting Ably channel limits.
        const autoAttach = index < MAX_AUTO_ATTACH;
        const showConversation = autoAttach || manuallyExpanded.has(esc.sessionId);

        return (
          <div
            key={esc.id}
            className={`rounded-xl border p-4 space-y-3 ${
              esc.status === 'resolved'
                ? 'border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-900/10'
                : 'border-zinc-200 dark:border-zinc-700'
            }`}
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{esc.customerName}</span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      esc.status === 'pending'
                        ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'
                        : esc.status === 'resolved'
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                          : 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                    }`}
                  >
                    {esc.status}
                  </span>
                </div>
                <p className="text-xs text-zinc-400 font-mono mt-0.5">{esc.sessionId}</p>
              </div>
              <div className="flex items-center gap-3">
                {!autoAttach && (
                  <button
                    onClick={() =>
                      setManuallyExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(esc.sessionId)) next.delete(esc.sessionId);
                        else next.add(esc.sessionId);
                        return next;
                      })
                    }
                    className="text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400"
                  >
                    {showConversation ? 'Hide conversation' : 'Show conversation'}
                  </button>
                )}
                <span className="text-xs text-zinc-400">
                  {esc.messageCount} messages
                </span>
                <button
                  onClick={() => dismiss(esc)}
                  className="text-xs text-zinc-400 hover:text-red-500 transition-colors"
                  title="Dismiss"
                >
                  &times;
                </button>
              </div>
            </div>

            <p className="text-sm text-zinc-600 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-800 rounded-lg p-3">
              {esc.reason}
            </p>

            {/* Inline conversation — auto-attached for recent sessions, manual toggle for older ones */}
            {showConversation && (
              <ChannelProvider
                channelName={`ai:support:${esc.sessionId}`}
                options={{ params: { rewind: '100' } }}
              >
                <SessionConversation sessionId={esc.sessionId} />
              </ChannelProvider>
            )}

            {esc.status !== 'resolved' && (
              <div className="space-y-2">
                <textarea
                  value={responseText[esc.sessionId] ?? ''}
                  onChange={(e) =>
                    setResponseText((prev) => ({ ...prev, [esc.sessionId]: e.target.value }))
                  }
                  placeholder="Type your response..."
                  className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                  rows={2}
                />
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => respond(esc.sessionId, 'respond')}
                    disabled={sending[esc.sessionId] || !responseText[esc.sessionId]?.trim()}
                    className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-4 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50 transition-colors"
                  >
                    Respond
                  </button>
                  <button
                    onClick={() => respond(esc.sessionId, 'resolve')}
                    disabled={sending[esc.sessionId] || !responseText[esc.sessionId]?.trim()}
                    className="rounded-lg bg-green-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
                  >
                    Resolve
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function AgentDashboard() {
  return (
    <ChannelProvider channelName="ai:agent:escalations" options={{ params: { rewind: '100' } }}>
      <EscalationList />
    </ChannelProvider>
  );
}
