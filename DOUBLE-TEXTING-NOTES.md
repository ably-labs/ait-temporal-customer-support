# Double-Texting Implementation — Coordinated Delivery Approach

> **Status: Exploratory / Superseded**
> This branch implements a coordinated double-texting pattern where a one-shot
> agent accumulates its response locally, waits for the primary agent to finish,
> then delivers in order. After research and review, we concluded this approach
> is over-engineered for a demo and not idiomatic with how the industry handles
> this pattern. A simpler approach is being pursued on a separate branch.

## What this branch implements

When a user sends an independent message while the AI agent is working:

1. **Intent classification** — A fast Haiku LLM call classifies the new message
   as `steer` (redirect current task), `double-text` (independent request), or
   `stop` (cancel).

2. **One-shot workflow** — For `double-text`, a parallel workflow spins up that:
   - Processes the LLM response locally (accumulates tokens in memory)
   - Waits for the predecessor agent to leave Ably Presence
   - Delivers the accumulated response to the Ably channel
   - Merges context back into the primary workflow

3. **Presence coordination** — An `AgentPresenceCoordinator` manages presence
   enter/leave and control message subscriptions. The `waitForPredecessor`
   method uses presence polling with self-exclusion to ensure delivery order.

4. **Multi-agent frontend** — The `useAgentPresence` hook was rewritten to track
   per-taskId presence state, showing "2 agents working" in the status bar.

## Complexity assessment

| Component | New LOC | Purpose |
|-----------|---------|---------|
| `one-shot-workflow.ts` | 58 | One-shot Temporal workflow |
| `one-shot-activities.ts` | 303 | Local LLM processing, predecessor wait, delivery |
| `classify-intent.ts` | 54 | Intent classification |
| Steer route changes | ~50 | Classification routing |
| `useAgentPresence` rewrite | ~150 | Multi-agent presence tracking |
| `ably-clients.ts` changes | ~36 | taskId support + closeAfterHandover |
| Workflow merge signal | ~8 | Context merge handler |
| **Total** | **~660** | |

## Why this approach is being reconsidered

### Industry patterns don't include coordinated parallel delivery

LangGraph defines four double-texting strategies (reject, enqueue, interrupt,
rollback) — **none involve running two agents in parallel within the same
conversation thread**. They all treat double-texting as a conflict resolution
problem for a single thread.

- **ChatGPT / Claude (web)**: Block input during generation
- **Claude Code**: Interrupts the current task, starts new one below (no coordination)
- **OpenAI Codex**: Runs parallel tasks in completely separate threads/worktrees
- **Intercom / Zendesk**: Enqueue — second message processed after first finishes
- **LangGraph**: Interrupt is the most common — cancel current, start new

### The accumulate-wait-deliver pipeline solves a problem nobody has

No production AI system coordinates delivery order between parallel agents in
the same chat thread. The complexity of `processLLMLocally` → `waitForPredecessor`
→ `deliverAccumulated` is substantial (~300 lines) and solves a self-imposed
ordering constraint that users don't actually expect.

### The simpler pattern is more impressive

Streaming both agents' responses simultaneously (no accumulation, no waiting)
actually looks *better* — it demonstrates true parallelism. Combined with a
visually distinct rendering for the one-shot agent (a card/panel vs normal
chat bubbles), the user clearly sees both agents working independently.

## Proposed simpler approach

~150 LOC total instead of ~660:

- Keep `classify-intent.ts` (50 lines, essential)
- One-shot workflow calls the **same** `callLLMStreaming`/`executeToolCall`
  activities directly — no custom steps
- Tag one-shot messages with `taskId` in `extras.headers`
- Frontend renders tagged messages in a visually distinct card
- No coordination, no accumulation, no merge-back, no presence rewrite

## References

- [LangGraph Double Texting Concepts](https://github.com/langchain-ai/langgraph/blob/main/docs/docs/concepts/double_texting.md)
- [LangChain Blog: UX for Agents](https://www.blog.langchain.com/ux-for-agents-part-1-chat-2/)
- [OpenAI Codex Multi-Agent](https://developers.openai.com/codex/multi-agent/)
- [Claude Code Sub-Agent Patterns](https://claudefa.st/blog/guide/agents/sub-agent-best-practices)
