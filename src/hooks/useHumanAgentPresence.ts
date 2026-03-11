'use client';

import { usePresenceListener } from 'ably/react';

/**
 * useHumanAgentPresence — tracks whether a human support agent is viewing
 * the customer's session channel. The agent dashboard enters presence with
 * clientId 'support-agent' when viewing an escalated conversation.
 *
 * Unlike the AI agent presence hook (which has complex handover/timeout
 * logic for durable execution steps), human agent presence is simple:
 * either the agent's browser is connected to the channel or it isn't.
 */
export function useHumanAgentPresence(channelName: string) {
  const { presenceData } = usePresenceListener(channelName);
  const humanAgentPresent = presenceData.some(
    (m) => m.clientId === 'support-agent'
  );
  return { humanAgentPresent };
}
