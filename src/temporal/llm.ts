import Anthropic from '@anthropic-ai/sdk';
import type { Message } from './workflows';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is required');
    client = new Anthropic({ apiKey });
  }
  return client;
}

export const SYSTEM_PROMPT = `You are a helpful customer support agent for Acme Corp, an online retailer.

You can help customers with:
- Order tracking and delivery status
- Refund inquiries
- Account information
- Researching issues and investigating problems

Be concise, friendly, and professional. When you need to look up information, use the available tools.

If a customer asks you to research something, investigate an issue, or asks a general "why" question about delays/problems/issues, use the doResearch tool immediately — do not ask for more details first. The research tool will check multiple sources on their behalf.

If a customer has a billing dispute, complex complaint, or requests to speak with a human, use the escalateToHuman tool. Do not try to handle these situations yourself.

Do not make up order details, tracking numbers, or account information — always use the tools to look them up.`;

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'lookupOrder',
    description: 'Look up an order by order ID to get status, tracking number, and estimated delivery date.',
    input_schema: {
      type: 'object' as const,
      properties: {
        orderId: { type: 'string', description: 'The order ID (e.g. #12345)' },
      },
      required: ['orderId'],
    },
  },
  {
    name: 'checkRefundStatus',
    description: 'Check the status of a refund request by refund ID or order ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        refundId: { type: 'string', description: 'The refund or order ID' },
      },
      required: ['refundId'],
    },
  },
  {
    name: 'getAccountDetails',
    description: 'Get account details for a customer by their customer ID or name.',
    input_schema: {
      type: 'object' as const,
      properties: {
        customerId: { type: 'string', description: 'The customer ID or name' },
      },
      required: ['customerId'],
    },
  },
  {
    name: 'escalateToHuman',
    description: 'Escalate the conversation to a human support agent. Use this when the customer has a billing dispute, complex complaint, or explicitly requests to speak with a human.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: { type: 'string', description: 'Brief reason for escalation' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'doResearch',
    description: 'Perform in-depth research on a topic. This is a long-running operation that checks multiple sources. Use this when the customer asks you to research something, investigate an issue thoroughly, or compare options.',
    input_schema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'The research topic or question to investigate' },
      },
      required: ['topic'],
    },
  },
];

export interface StreamCallbacks {
  onToken: (text: string) => void;
  heartbeat: () => void;
  abortSignal?: AbortSignal;
}

export interface LLMStreamResult {
  type: 'text' | 'tool_use' | 'escalate';
  fullText: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  // Raw content blocks from Claude — needed for tool_use round-trips.
  // The assistant message must include the tool_use block for Claude to
  // accept the subsequent tool_result.
  rawContentBlocks?: unknown[];
}

/**
 * Stream a Claude response, calling onToken for each text delta.
 * Returns the full result including tool use detection and escalation.
 */
export async function streamClaude(
  messages: Message[],
  callbacks: StreamCallbacks
): Promise<LLMStreamResult> {
  const anthropic = getClient();

  // Convert our message format to Anthropic's format
  const anthropicMessages: Anthropic.MessageParam[] = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'user' as const,
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: m.toolUseId ?? 'unknown',
              content: m.content,
            },
          ],
        };
      }
      // Assistant messages with tool_use need the raw content blocks
      if (m.role === 'assistant' && m.rawContentBlocks) {
        return {
          role: 'assistant' as const,
          content: m.rawContentBlocks as Anthropic.ContentBlock[],
        };
      }
      return {
        role: m.role as 'user' | 'assistant',
        content: m.content,
      };
    });

  const stream = anthropic.messages.stream({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: anthropicMessages,
    tools: TOOLS,
  });

  let fullText = '';
  let toolName: string | undefined;
  let toolInput: Record<string, unknown> | undefined;
  let toolInputJson = '';
  let toolUseId: string | undefined;
  let hasToolUse = false;

  let aborted = false;

  for await (const event of stream) {
    // Check abort signal — stop consuming tokens if steering/stop received
    if (callbacks.abortSignal?.aborted) {
      aborted = true;
      stream.abort();
      break;
    }

    callbacks.heartbeat();

    if (event.type === 'content_block_start') {
      if (event.content_block.type === 'tool_use') {
        hasToolUse = true;
        toolName = event.content_block.name;
        toolUseId = event.content_block.id;
        toolInputJson = '';
      }
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        fullText += event.delta.text;
        callbacks.onToken(event.delta.text);
      } else if (event.delta.type === 'input_json_delta') {
        toolInputJson += event.delta.partial_json;
      }
    }
  }

  if (aborted) {
    return { type: 'text', fullText };
  }

  // Parse tool input if we got a tool use
  if (hasToolUse && toolInputJson) {
    try {
      toolInput = JSON.parse(toolInputJson);
    } catch {
      toolInput = {};
    }
  }

  if (hasToolUse) {
    // Escalation is a tool call — detected by toolName below
    if (toolName === 'escalateToHuman') {
      return {
        type: 'escalate',
        fullText,
        toolName,
        toolInput,
        toolUseId,
      };
    }

    // Build the raw content blocks that Claude expects for tool_use round-trips
    const rawContentBlocks: unknown[] = [];
    if (fullText) {
      rawContentBlocks.push({ type: 'text', text: fullText });
    }
    rawContentBlocks.push({
      type: 'tool_use',
      id: toolUseId,
      name: toolName,
      input: toolInput ?? {},
    });

    return {
      type: 'tool_use',
      fullText,
      toolName,
      toolInput,
      toolUseId,
      rawContentBlocks,
    };
  }

  return { type: 'text', fullText };
}
