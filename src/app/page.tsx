'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function Home() {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  const startSession = async () => {
    const customerName = name.trim() || 'Customer';
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerName }),
      });

      if (!res.ok) {
        const err = await res.json();
        setError(err.error || 'Failed to create session');
        return;
      }

      const { sessionId } = await res.json();
      router.push(`/session/${sessionId}`);
    } catch {
      setError('Failed to connect. Is the server running?');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      startSession();
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <main className="flex flex-col items-center gap-6 text-center max-w-md w-full px-4">
        <div>
          <h1 className="text-3xl font-semibold">Customer Support Copilot</h1>
          <p className="text-zinc-500 mt-1">
            Ably AI Transport + Temporal Durable Execution
          </p>
        </div>

        <div className="w-full space-y-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Your name (optional)"
            className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-transparent px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <button
            onClick={startSession}
            disabled={loading}
            className="w-full rounded-lg bg-blue-600 px-5 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Starting...' : 'Start conversation'}
          </button>
          {error && <p className="text-red-500 text-sm">{error}</p>}
        </div>

        <p className="text-xs text-zinc-400">
          AI support agent powered by Claude. Ask about orders, refunds, or account info.
        </p>
      </main>
    </div>
  );
}
