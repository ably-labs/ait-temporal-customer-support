'use client';

import { use } from 'react';
import Link from 'next/link';
import { ChannelProvider } from 'ably/react';
import AblyProviderWrapper from '@/components/AblyProviderWrapper';
import ChatSession from '@/components/ChatSession';

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = use(params);
  const channelName = `ai:support:${sessionId}`;

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <header className="shrink-0 border-b border-zinc-200 dark:border-zinc-700 px-4 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Support Chat</h1>
          <p className="text-xs text-zinc-400 font-mono">
            {sessionId}
            <span className="ml-2 text-zinc-500 dark:text-zinc-400 font-sans font-medium">
              Temporal + Ably AI Transport demo
            </span>
          </p>
        </div>
        <Link
          href="/"
          className="text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400"
        >
          New session
        </Link>
      </header>
      <AblyProviderWrapper clientId={`customer-${sessionId}`} className="flex-1 min-h-0 flex flex-col">
        <ChannelProvider channelName={channelName} options={{ params: { rewind: '100' } }}>
          <ChatSession sessionId={sessionId} />
        </ChannelProvider>
      </AblyProviderWrapper>
    </div>
  );
}
