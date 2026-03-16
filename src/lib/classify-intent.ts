import Anthropic from '@anthropic-ai/sdk';

export type Intent = 'steer' | 'double-text' | 'stop';

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
- "steer" = user is CORRECTING or MODIFYING the same task. The new message references the SAME specific item/topic.
- "double-text" = user wants ADDITIONAL work on a DIFFERENT topic/item. Phrases like "while you're doing that", "also", "by the way", "separately" strongly signal double-text.

Key distinction: "steer" replaces the current task. "double-text" adds a new parallel task.

Reply with exactly one word: stop, steer, or double-text`,
      messages: [{ role: 'user', content: `CURRENT task: "${currentTaskSummary || '(unknown)'}"\nNEW message: "${newMessage}"\n\nClassification:` }],
    }, { signal: controller.signal });
    clearTimeout(timeout);
    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const normalized = text.trim().toLowerCase();
    if (normalized.includes('double-text') || normalized.includes('doubletext')) return 'double-text';
    if (normalized.includes('stop')) return 'stop';
    return 'steer';
  } catch {
    return 'steer';
  }
}
