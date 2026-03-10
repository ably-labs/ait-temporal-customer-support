'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useChannel, usePresenceListener } from 'ably/react';
import type Ably from 'ably';
import { MessageAccumulator } from '@/lib/message-accumulator';

interface ChatMessage {
  id: string; // serial for confirmed messages, messageId for pending
  type: 'text' | 'tool' | 'escalation';
  role: 'user' | 'assistant' | 'system';
  content: string;
  isStreaming: boolean;
  source?: 'human-agent'; // set when a human agent sends the message
  toolData?: { toolName: string; input: Record<string, unknown>; status: string; result?: unknown; progress?: { step: number; total: number; label: string } };
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

  // Track agent presence with handover-aware logic.
  // Per-session clientId format: 'ai-agent:<sessionId>'
  // Activities enter/leave presence independently, using { status: 'handing-over' }
  // on leave when more steps may follow. A 10-second timeout bridges the gap
  // between activities so the UI stays in "thinking" state during handovers.
  const { presenceData } = usePresenceListener(channelName);
  const handoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [handingOver, setHandingOver] = useState(false);

  // An agent member is any presence entry with clientId starting with 'ai-agent:'
  const agentMembers = presenceData.filter(
    (m) => m.clientId?.startsWith('ai-agent:')
  );

  // Determine the best state across all agent members:
  // processing (active) > handing-over (between activities) > absent
  const anyProcessing = agentMembers.some(
    (m) => (m.data as Record<string, unknown>)?.status === 'processing'
  );

  // Agent is actively present if any member is processing OR we are in a handover window
  const agentPresent = anyProcessing || handingOver;

  // Listen for presence leave events to detect handover vs. terminal leave
  useEffect(() => {
    const handlePresenceLeave = () => {
      // Check if any remaining members are still processing
      const stillProcessing = agentMembers.some(
        (m) => (m.data as Record<string, unknown>)?.status === 'processing'
      );
      if (stillProcessing) return;

      // Check if any member left with handing-over status
      const lastLeaver = presenceData.find(
        (m) => m.clientId?.startsWith('ai-agent:') &&
               m.action === 'leave' &&
               (m.data as Record<string, unknown>)?.status === 'handing-over'
      );

      if (lastLeaver) {
        // Handing over — stay in "thinking" state with a 10-second timeout
        setHandingOver(true);
        if (handoverTimeoutRef.current) clearTimeout(handoverTimeoutRef.current);
        handoverTimeoutRef.current = setTimeout(() => {
          setHandingOver(false);
          handoverTimeoutRef.current = null;
        }, 10_000);
      } else {
        // Terminal leave (no handover data) — agent is gone
        setHandingOver(false);
        if (handoverTimeoutRef.current) {
          clearTimeout(handoverTimeoutRef.current);
          handoverTimeoutRef.current = null;
        }
      }
    };

    handlePresenceLeave();

    return () => {
      if (handoverTimeoutRef.current) {
        clearTimeout(handoverTimeoutRef.current);
      }
    };
  }, [presenceData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear handover state when an agent enters (new activity started)
  useEffect(() => {
    if (anyProcessing && handingOver) {
      setHandingOver(false);
      if (handoverTimeoutRef.current) {
        clearTimeout(handoverTimeoutRef.current);
        handoverTimeoutRef.current = null;
      }
    }
  }, [anyProcessing, handingOver]);

  // Crash detection state machine — derived from message status + presence.
  // The last agent message's terminal status is the source of truth:
  //   - Has terminal status ('complete'/'stopped') → done
  //   - No terminal status + agent present         → working
  //   - No terminal status + agent absent          → crashed
  const lastAgentMessage = [...messages].reverse().find(
    (m) => m.type === 'text' && m.role === 'assistant'
  );
  const hasUnterminated = lastAgentMessage?.isStreaming === true;
  const agentCrashed = hasUnterminated && !agentPresent;

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
            { id: serial, type: 'text', role: 'user', content: result.data, isStreaming: false },
          ];
        });
        return;
      }

      if (name === 'response') {
        const headers = result.extras?.headers as Record<string, string> | undefined;
        const source = headers?.source === 'human-agent'
          ? 'human-agent' as const
          : undefined;
        setMessages((prev) => {
          const existing = prev.find((m) => m.id === serial);
          if (existing) {
            return prev.map((m) =>
              m.id === serial
                ? { ...m, content: result.data, isStreaming: !result.isComplete, source: source ?? m.source }
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
        let toolData: ChatMessage['toolData'];
        try {
          toolData = JSON.parse(result.data);
        } catch {
          return;
        }
        setMessages((prev) => {
          const existing = prev.find((m) => m.id === serial);
          if (existing) {
            return prev.map((m) =>
              m.id === serial ? { ...m, toolData, content: result.data } : m
            );
          }
          return [
            ...prev,
            { id: serial, type: 'tool', role: 'system', content: result.data, isStreaming: false, toolData },
          ];
        });
        return;
      }

      if (name === 'escalation') {
        setMessages((prev) => {
          const existing = prev.find((m) => m.id === serial);
          if (existing) return prev;
          return [
            ...prev,
            { id: serial, type: 'escalation', role: 'system', content: result.data, isStreaming: false },
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
      { id: messageId, type: 'text', role: 'user', content: text, isStreaming: false },
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

  const isStreaming = messages.some((m) => m.isStreaming);
  // Agent is working if streaming OR present (covers tool execution like doResearch)
  const isAgentWorking = isStreaming || agentPresent;

  const stopGeneration = async () => {
    try {
      await fetch(`/api/sessions/${sessionId}/steer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
    } catch (err) {
      console.error('Failed to stop:', err);
    }
  };

  const sendMessageWhileStreaming = async (text: string) => {
    const messageId = `user_${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // Optimistic UI
    setMessages((prev) => [
      ...prev,
      { id: messageId, type: 'text', role: 'user', content: text, isStreaming: false },
    ]);
    setInput('');

    try {
      await fetch(`/api/sessions/${sessionId}/steer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'newMessage', text, messageId }),
      });
    } catch (err) {
      console.error('Failed to steer:', err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isAgentWorking && input.trim()) {
        sendMessageWhileStreaming(input.trim());
      } else {
        sendMessage();
      }
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Agent status bar */}
      {agentCrashed && (
        <div className="bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 px-4 py-2 text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-red-500" />
          Agent disconnected
        </div>
      )}
      {agentPresent && !agentCrashed && (
        <div className="bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-800 px-4 py-2 text-sm text-blue-700 dark:text-blue-300 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
          AI is thinking...
        </div>
      )}
      {/* Message list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <p className="text-center text-zinc-400 mt-8">
            Send a message to start the conversation.
          </p>
        )}
        {messages.map((msg) => {
          // Tool call card
          if (msg.type === 'tool') {
            const tool = msg.toolData;
            return (
              <div key={msg.id} className="flex justify-start">
                <div className="max-w-[75%] rounded-xl border border-zinc-200 dark:border-zinc-700 px-4 py-3 text-sm">
                  <div className="flex items-center gap-2 text-zinc-500 text-xs font-medium mb-1.5">
                    <span className="font-mono">{tool?.toolName}</span>
                    {tool?.status === 'calling' && (
                      <span className="animate-pulse">
                        {tool.progress
                          ? `${tool.progress.label} (${tool.progress.step}/${tool.progress.total})`
                          : 'running...'}
                      </span>
                    )}
                    {tool?.status === 'complete' && (
                      <span className="text-green-600 dark:text-green-400">done</span>
                    )}
                    {tool?.status === 'cancelled' && (
                      <span className="text-amber-600 dark:text-amber-400">interrupted</span>
                    )}
                  </div>
                  {tool?.status === 'complete' && tool.result != null && (
                    <pre className="text-xs text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900 rounded p-2 overflow-x-auto">
                      {JSON.stringify(tool.result, null, 2)}
                    </pre>
                  )}
                </div>
              </div>
            );
          }

          // System notice (escalation, agent joined, resolved, etc.)
          if (msg.type === 'escalation') {
            const isResolution = msg.content.toLowerCase().includes('resolved');
            return (
              <div key={msg.id} className="flex justify-center">
                <div className={`rounded-lg px-4 py-2.5 text-sm max-w-[85%] text-center ${
                  isResolution
                    ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-800 dark:text-green-200'
                    : 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200'
                }`}>
                  {msg.content}
                </div>
              </div>
            );
          }

          // Regular text message — hide empty assistant bubbles (the initial
          // response publish creates data: '' which gets a gray bubble before
          // any tokens arrive; after abort these stay empty permanently).
          if (msg.role === 'assistant' && !msg.content && !msg.isStreaming) {
            return null;
          }
          const isHuman = msg.source === 'human-agent';
          return (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div className={`max-w-[75%] ${msg.role !== 'user' ? 'space-y-1' : ''}`}>
                {/* Label for human agent messages */}
                {isHuman && (
                  <div className="flex items-center gap-1.5 ml-1 mb-0.5">
                    <span className="w-2 h-2 rounded-full bg-green-500" />
                    <span className="text-xs font-medium text-green-700 dark:text-green-400">
                      Support Agent
                    </span>
                  </div>
                )}
                <div
                  className={`rounded-xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : isHuman
                        ? 'bg-green-50 dark:bg-green-900/20 text-foreground border border-green-200 dark:border-green-800'
                        : 'bg-zinc-100 dark:bg-zinc-800 text-foreground'
                  }`}
                >
                  {msg.content}
                  {msg.isStreaming && (
                    <span className="inline-block w-1.5 h-4 ml-0.5 bg-current opacity-60 animate-pulse" />
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      {(() => {
        const isResolved = messages.some(
          (m) => m.type === 'escalation' && m.content.toLowerCase().includes('resolved')
        );
        if (isResolved) {
          return (
            <div className="border-t border-zinc-200 dark:border-zinc-700 p-4 text-center text-sm text-zinc-400">
              This session has ended.
            </div>
          );
        }
        return (
          <div className="border-t border-zinc-200 dark:border-zinc-700 p-4">
            <div className="flex gap-2 max-w-3xl mx-auto">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={isAgentWorking ? 'Type to interrupt or redirect...' : 'Type a message...'}
                className={`flex-1 rounded-lg border bg-transparent px-4 py-2.5 text-sm outline-none focus:ring-2 focus:border-transparent transition-colors ${
                  isAgentWorking
                    ? 'border-amber-300 dark:border-amber-600 focus:ring-amber-500'
                    : 'border-zinc-300 dark:border-zinc-600 focus:ring-blue-500'
                }`}
                disabled={sending}
              />
              {isAgentWorking ? (
                <button
                  onClick={input.trim() ? () => sendMessageWhileStreaming(input.trim()) : stopGeneration}
                  className={`rounded-lg px-5 py-2.5 text-sm font-medium transition-colors ${
                    input.trim()
                      ? 'bg-amber-600 text-white hover:bg-amber-700'
                      : 'bg-red-600 text-white hover:bg-red-700'
                  }`}
                >
                  {input.trim() ? 'Send' : 'Stop'}
                </button>
              ) : (
                <button
                  onClick={sendMessage}
                  disabled={sending || !input.trim()}
                  className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Send
                </button>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
