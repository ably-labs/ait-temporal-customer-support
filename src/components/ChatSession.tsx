'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useChannel } from 'ably/react';
import type Ably from 'ably';
import { MessageAccumulator } from '@/lib/message-accumulator';
import { useAgentPresence } from '@/hooks/useAgentPresence';
import { useHumanAgentPresence } from '@/hooks/useHumanAgentPresence';

interface ChatMessage {
  id: string; // serial for confirmed messages, messageId for pending
  type: 'text' | 'tool' | 'escalation';
  role: 'user' | 'assistant' | 'system';
  content: string;
  isStreaming: boolean;
  source?: 'human-agent'; // set when a human agent sends the message
  escalationType?: 'escalated' | 'resolved'; // from extras.headers['x-escalation-type']
  toolData?: { toolName: string; input: Record<string, unknown>; status: string; result?: unknown; progress?: { step: number; total: number; label: string }; taskId?: string };
  taskId?: string; // present for parallel (double-text) agent responses
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

  // Track AI agent presence with handover-aware logic (extracted to reusable hook)
  const { agentStatus, agentWorking: agentPresent, clearHandover } = useAgentPresence(channelName);
  // Track human support agent presence (simple: present or not)
  const { humanAgentPresent } = useHumanAgentPresence(channelName);

  // Crash detection state machine — derived from message status + presence.
  // The last agent message's terminal status is the source of truth:
  //   - Has terminal status ('complete'/'stopped') → done
  //   - No terminal status + agent present         → working
  //   - No terminal status + agent absent          → crashed
  const lastAgentMessage = [...messages].reverse().find(
    (m) => m.type === 'text' && m.role === 'assistant'
  );
  const hasUnterminated = lastAgentMessage?.isStreaming === true;
  const agentCrashed = hasUnterminated && agentStatus === 'absent';

  // Show an in-chat notice when a human agent joins or leaves (presence-driven).
  // These messages are ephemeral — they live in React state only and are lost on
  // page reload. For a demo this is acceptable; a production app would persist
  // them as Ably messages or reconstruct from presence history.
  // Uses a ref to track previous state and avoid duplicate messages on mount.
  const prevHumanPresent = useRef<boolean | null>(null);
  useEffect(() => {
    // Skip the initial render — only react to changes
    if (prevHumanPresent.current === null) {
      prevHumanPresent.current = humanAgentPresent;
      return;
    }
    if (humanAgentPresent && !prevHumanPresent.current) {
      setMessages((prev) => [
        ...prev,
        {
          id: `presence-join-${Date.now()}`,
          type: 'escalation',
          role: 'system',
          content: 'A support agent has joined the conversation.',
          isStreaming: false,
        },
      ]);
    } else if (!humanAgentPresent && prevHumanPresent.current) {
      setMessages((prev) => [
        ...prev,
        {
          id: `presence-leave-${Date.now()}`,
          type: 'escalation',
          role: 'system',
          content: 'The support agent has left the conversation.',
          isStreaming: false,
        },
      ]);
    }
    prevHumanPresent.current = humanAgentPresent;
  }, [humanAgentPresent]);

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
        // When a response message completes, the `next` header tells us whether
        // the agent's turn is over or more steps follow:
        //   'text'      → turn is done, clear handover immediately
        //   'tool_use'  → tool call follows, don't clear (presence handover bridges the gap)
        //   'escalate'  → escalation follows, don't clear (escalation handler will clear)
        //   absent      → stopped/aborted, clear immediately
        if (result.isComplete) {
          const completionHeaders = result.extras?.headers as Record<string, string> | undefined;
          const next = completionHeaders?.next;
          if (!next || next === 'text') {
            clearHandover();
          }
          // 'tool_use' or 'escalate' → leave handover active, next step will handle it
        }
        const headers = result.extras?.headers as Record<string, string> | undefined;
        const source = headers?.source === 'human-agent'
          ? 'human-agent' as const
          : undefined;
        const responseTaskId = headers?.taskId;
        setMessages((prev) => {
          const existing = prev.find((m) => m.id === serial);
          if (existing) {
            return prev.map((m) =>
              m.id === serial
                ? { ...m, content: result.data, isStreaming: !result.isComplete, source: source ?? m.source, taskId: responseTaskId ?? m.taskId }
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
              taskId: responseTaskId,
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
        // A cancelled tool means the agent's turn was interrupted — clear handover
        // so the "AI is thinking" indicator disappears. Without this, the client
        // waits for the 10s handover timeout because the preceding response message
        // had `next: 'tool_use'` (which deliberately skipped clearHandover).
        if (toolData?.status === 'cancelled') {
          clearHandover();
        }
        const toolTaskId = toolData?.taskId;
        setMessages((prev) => {
          const existing = prev.find((m) => m.id === serial);
          if (existing) {
            return prev.map((m) =>
              m.id === serial ? { ...m, toolData, content: result.data, taskId: toolTaskId ?? m.taskId } : m
            );
          }
          return [
            ...prev,
            { id: serial, type: 'tool', role: 'system', content: result.data, isStreaming: false, toolData, taskId: toolTaskId },
          ];
        });
        return;
      }

      if (name === 'escalation') {
        // Clear handover so the "AI is thinking" indicator disappears immediately.
        // This is the fallback for cases where no response message with a `next`
        // header follows (e.g., escalation after tool execution, stop during tool).
        clearHandover();
        const escalationHeaders = result.extras?.headers as Record<string, string> | undefined;
        const escalationType = escalationHeaders?.['x-escalation-type'] as 'escalated' | 'resolved' | undefined;
        setMessages((prev) => {
          const existing = prev.find((m) => m.id === serial);
          if (existing) return prev;
          return [
            ...prev,
            { id: serial, type: 'escalation', role: 'system', content: result.data, isStreaming: false, escalationType },
          ];
        });
      }
    },
    [accumulator, clearHandover]
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

  // Escalation state — derived from escalation messages
  const isEscalated = messages.some((m) => m.escalationType === 'escalated')
    && !messages.some((m) => m.escalationType === 'resolved');

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

  // Derive a summary of the current task from the last user message (for intent classification)
  const currentTaskSummary = [...messages].reverse().find((m) => m.role === 'user')?.content || '';

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
        body: JSON.stringify({ action: 'newMessage', text, messageId, currentTaskSummary }),
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
      {/* Agent status bar — priority: crashed > human agent > AI thinking > waiting for agent */}
      {agentCrashed && (
        <div className="bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 px-4 py-2 text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-red-500" />
          Agent disconnected
        </div>
      )}
      {!agentCrashed && humanAgentPresent && (
        <div className="bg-green-50 dark:bg-green-900/20 border-b border-green-200 dark:border-green-800 px-4 py-2 text-sm text-green-700 dark:text-green-300 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          Support agent is online
        </div>
      )}
      {!agentCrashed && !humanAgentPresent && agentPresent && (
        <div className="bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-800 px-4 py-2 text-sm text-blue-700 dark:text-blue-300 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
          AI is thinking...
        </div>
      )}
      {!agentCrashed && !humanAgentPresent && !agentPresent && isEscalated && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800 px-4 py-2 text-sm text-amber-700 dark:text-amber-300 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-amber-400" />
          Waiting for a support agent...
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
          // Parallel agent card (double-text) — indigo border to distinguish from main agent
          if (msg.taskId && msg.type === 'text' && msg.role === 'assistant') {
            if (!msg.content && !msg.isStreaming) return null;
            return (
              <div key={msg.id} className="flex justify-start">
                <div className="max-w-[75%] space-y-1">
                  <div className="flex items-center gap-1.5 ml-1 mb-0.5">
                    <span className="w-2 h-2 rounded-full bg-indigo-500" />
                    <span className="text-xs font-medium text-indigo-700 dark:text-indigo-400">
                      Parallel Agent
                    </span>
                  </div>
                  <div className="rounded-xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap bg-indigo-50 dark:bg-indigo-900/20 text-foreground border border-indigo-200 dark:border-indigo-800">
                    {msg.content}
                    {msg.isStreaming && (
                      <span className="inline-block w-1.5 h-4 ml-0.5 bg-current opacity-60 animate-pulse" />
                    )}
                  </div>
                </div>
              </div>
            );
          }

          // Parallel agent tool card (double-text)
          if (msg.taskId && msg.type === 'tool') {
            const tool = msg.toolData;
            return (
              <div key={msg.id} className="flex justify-start">
                <div className="max-w-[75%] rounded-xl border border-indigo-200 dark:border-indigo-700 px-4 py-3 text-sm">
                  <div className="flex items-center gap-2 text-indigo-500 text-xs font-medium mb-1.5">
                    <span className="w-2 h-2 rounded-full bg-indigo-500" />
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
            const isResolution = msg.escalationType === 'resolved';
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
          (m) => m.type === 'escalation' && m.escalationType === 'resolved'
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
