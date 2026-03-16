import Anthropic from '@anthropic-ai/sdk';

export type Intent = 'steer' | 'double-text' | 'stop';

/**
 * Classify a user's intent when they send a new message while the AI agent
 * is still working on a current task.
 *
 * Uses Claude Haiku for fast classification (~200-500ms).
 * Falls back to 'steer' on any error or timeout.
 */
export async function classifyIntent(
  newMessage: string,
  currentTaskSummary: string
): Promise<Intent> {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return 'steer';

    const client = new Anthropic({ apiKey });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      system: `Classify the user's intent. They sent a NEW message while an AI agent is still working on a CURRENT task.

Rules:
- "stop" = user wants to cancel/abort. Keywords: stop, cancel, never mind, forget it, quit, halt.
- "steer" = user is CORRECTING or MODIFYING the same task. The new message references the SAME specific item/topic. Examples: "actually check order 5678 instead", "no I meant the other one", "also include tracking info for that".
- "double-text" = user wants ADDITIONAL work on a DIFFERENT topic/item. Even if both are orders, if the new message asks about a DIFFERENT order number or a DIFFERENT subject, it's double-text. Phrases like "while you're doing that", "also", "by the way", "separately", "in the meantime" strongly signal double-text.

Key distinction: "steer" replaces the current task. "double-text" adds a new parallel task.

Reply with exactly one word: stop, steer, or double-text`,
      messages: [{
        role: 'user',
        content: `CURRENT task: "${currentTaskSummary || '(unknown)'}"\nNEW message: "${newMessage}"\n\nClassification:`,
      }],
    }, { signal: controller.signal });

    clearTimeout(timeout);

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const normalized = text.trim().toLowerCase();
    if (normalized.includes('double-text') || normalized.includes('double_text') || normalized.includes('doubletext')) return 'double-text';
    if (normalized.includes('stop')) return 'stop';
    if (normalized.includes('steer')) return 'steer';
    return 'steer';
  } catch {
    return 'steer';
  }
}
