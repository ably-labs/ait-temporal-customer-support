'use client';

import { ReactNode, useEffect, useState } from 'react';
import Ably from 'ably';
import { AblyProvider } from 'ably/react';

interface Props {
  clientId: string;
  children: ReactNode;
  className?: string;
}

export default function AblyProviderWrapper({ clientId, children, className }: Props) {
  // Defer Ably client creation to the browser — Realtime connects immediately
  // on construction, and relative fetch URLs don't work during SSR.
  const [client, setClient] = useState<Ably.Realtime | null>(null);

  useEffect(() => {
    const ably = new Ably.Realtime({
      authCallback: async (_tokenParams, callback) => {
        try {
          // Demo shortcut: clientId is passed from the client. In production,
          // the server assigns clientId from the authenticated user's session.
          const res = await fetch(`/api/ably-token?clientId=${encodeURIComponent(clientId)}`);
          if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
          const token = await res.text();
          callback(null, token);
        } catch (err) {
          callback(err instanceof Error ? err.message : 'Auth failed', null);
        }
      },
      clientId,
    });
    setClient(ably);
    return () => {
      ably.close();
    };
  }, [clientId]);

  if (!client) return null;

  return (
    <AblyProvider client={client}>
      {className ? <div className={className}>{children}</div> : children}
    </AblyProvider>
  );
}
