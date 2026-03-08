'use client';

import { ReactNode, useState } from 'react';
import Ably from 'ably';
import { AblyProvider } from 'ably/react';

interface Props {
  clientId: string;
  children: ReactNode;
}

export default function AblyProviderWrapper({ clientId, children }: Props) {
  // In production, the clientId would come from the authenticated session —
  // the server assigns it, not the client. Passing it as a query param here
  // is contrived but fine for the demo.
  const [client] = useState(
    () =>
      new Ably.Realtime({
        authUrl: `/api/ably-token?clientId=${encodeURIComponent(clientId)}`,
        clientId,
      })
  );

  return <AblyProvider client={client}>{children}</AblyProvider>;
}
