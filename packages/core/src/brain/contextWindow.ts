import type { Message, ToolCall } from '../types.js';

/**
 * Known context window limits (in tokens) per provider/model.
 * These are input token limits; output tokens are separate.
 */
const CONTEXT_LIMITS: Record<string, number> = {
  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4.1': 1_047_576,
  'gpt-4.1-mini': 1_047_576,
  'gpt-4.1-nano': 1_047_576,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'o3-mini': 200_000,
  'o3': 200_000,
  'o4-mini': 200_000,

  // Gemini
  'gemini-1.5-pro': 1_048_576,
  'gemini-1.5-flash': 1_048_576,
  'gemini-2.0-flash': 1_048_576,

  // Ollama / local (conservative defaults)
  'llama3': 8_192,
  'llama3.1': 128_000,
  'llama3.2': 128_000,
  'qwen2.5-coder': 32_768,
  'mistral': 32_768,
  'codellama': 16_384,
  'deepseek-coder': 16_384,
};

/** Default limit when model isn't recognized */
const DEFAULT_CONTEXT_LIMIT = 32_768;

/** Reserve tokens for the model's response */
const OUTPUT_RESERVE_TOKENS = 4_096;

/** Minimum number of recent user turns to always keep */
const MIN_RECENT_USER_TURNS = 2;

/**
 * Estimate token count for a string using the ~4 chars per token heuristic.
 * This is fast and reasonably accurate across models for planning purposes.
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  // Roughly 1 token per 4 characters for English text.
  // For code, it's closer to 1:3.5, so 4 is a conservative estimate.
  return Math.ceil(text.length / 4);
}

/**
 * Estimate token count for a single message including role overhead.
 */
export function estimateMessageTokens(message: Message): number {
  // Base overhead for message framing (role, separators)
  let tokens = 4;

  tokens += estimateTokenCount(message.content);

  if (message.toolCalls) {
    for (const tc of message.toolCalls) {
      tokens += estimateToolCallTokens(tc);
    }
  }

  if (message.toolCallId) {
    tokens += estimateTokenCount(message.toolCallId);
  }

  return tokens;
}

function estimateToolCallTokens(toolCall: ToolCall): number {
  let tokens = 4; // framing
  tokens += estimateTokenCount(toolCall.id);
  tokens += estimateTokenCount(toolCall.name);
  tokens += estimateTokenCount(JSON.stringify(toolCall.arguments));
  return tokens;
}

/**
 * Get the context window limit for a provider + model combination.
 */
export function getContextWindowLimit(provider: string, model: string): number {
  // Codex provider manages its own context window
  if (provider === 'openai-codex') {
    return Infinity;
  }

  // Strip provider prefix if present (e.g., "openai/gpt-4o" → "gpt-4o")
  const baseModel = model.includes('/') ? model.split('/').pop()! : model;

  // Try exact match first
  if (CONTEXT_LIMITS[baseModel] !== undefined) {
    return CONTEXT_LIMITS[baseModel];
  }

  // Try prefix match (e.g., "gpt-4o-2024-05-13" → "gpt-4o")
  for (const [key, limit] of Object.entries(CONTEXT_LIMITS)) {
    if (baseModel.startsWith(key)) {
      return limit;
    }
  }

  return DEFAULT_CONTEXT_LIMIT;
}

export interface ContextUsage {
  usedTokens: number;
  limitTokens: number;
  availableTokens: number;
  percent: number;
}

/**
 * Calculate context window usage for a set of messages against a limit.
 */
export function getContextUsage(messages: Message[], limitTokens: number): ContextUsage {
  if (!isFinite(limitTokens)) {
    return { usedTokens: 0, limitTokens: 0, availableTokens: Infinity, percent: 0 };
  }

  const usedTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const effectiveLimit = Math.max(limitTokens - OUTPUT_RESERVE_TOKENS, 0);
  const availableTokens = Math.max(effectiveLimit - usedTokens, 0);
  const percent = effectiveLimit > 0 ? Math.min(Math.round((usedTokens / effectiveLimit) * 100), 100) : 0;

  return { usedTokens, limitTokens, availableTokens, percent };
}

/**
 * Truncate messages to fit within a context window limit.
 *
 * Strategy:
 * 1. System message is always kept (first message).
 * 2. The most recent MIN_RECENT_USER_TURNS user messages and all messages
 *    after the first of those are always kept (the "tail").
 * 3. Tool call + tool result pairs are kept together — never split.
 * 4. Oldest middle messages are dropped first until we fit.
 * 5. If still over limit, a summary placeholder replaces dropped messages.
 */
export function truncateMessages(messages: Message[], limitTokens: number): Message[] {
  if (!isFinite(limitTokens)) {
    return messages;
  }

  const effectiveLimit = Math.max(limitTokens - OUTPUT_RESERVE_TOKENS, 0);
  const totalTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

  if (totalTokens <= effectiveLimit) {
    return messages;
  }

  // Partition: system (index 0) | middle | tail
  const systemMessage = messages[0]?.role === 'system' ? messages[0] : null;
  const contentMessages = systemMessage ? messages.slice(1) : [...messages];

  // Find the tail: last MIN_RECENT_USER_TURNS user messages + everything after the first of them
  const tailStartIndex = findTailStart(contentMessages, MIN_RECENT_USER_TURNS);
  const tail = contentMessages.slice(tailStartIndex);
  const middle = contentMessages.slice(0, tailStartIndex);

  // Calculate fixed token cost (system + tail)
  const systemTokens = systemMessage ? estimateMessageTokens(systemMessage) : 0;
  const tailTokens = tail.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const fixedTokens = systemTokens + tailTokens;

  if (fixedTokens >= effectiveLimit) {
    // Even system + tail exceed limit — return just system + tail, can't do better
    const result: Message[] = [];
    if (systemMessage) result.push(systemMessage);
    result.push(...tail);
    return result;
  }

  // Budget for middle messages
  const middleBudget = effectiveLimit - fixedTokens;

  // Group middle messages into coherent blocks (tool-call + result pairs stay together)
  const blocks = groupMessageBlocks(middle);

  // Fill from most recent blocks backward
  const keptBlocks: Message[][] = [];
  let middleUsed = 0;

  for (let i = blocks.length - 1; i >= 0; i--) {
    const blockTokens = blocks[i].reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    if (middleUsed + blockTokens <= middleBudget) {
      keptBlocks.unshift(blocks[i]);
      middleUsed += blockTokens;
    } else {
      break; // Stop once we can't fit the next block
    }
  }

  const droppedCount = middle.length - keptBlocks.reduce((sum, b) => sum + b.length, 0);
  const result: Message[] = [];
  if (systemMessage) result.push(systemMessage);

  if (droppedCount > 0) {
    result.push({
      role: 'system',
      content: `[${droppedCount} earlier messages were trimmed to fit the context window]`,
    });
  }

  for (const block of keptBlocks) {
    result.push(...block);
  }
  result.push(...tail);

  return result;
}

/**
 * Find the index in contentMessages where the "tail" starts.
 * The tail contains at least `minUserTurns` user messages.
 */
function findTailStart(messages: Message[], minUserTurns: number): number {
  let userCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      userCount++;
      if (userCount >= minUserTurns) {
        return i;
      }
    }
  }
  // If fewer user turns than minimum, keep everything
  return 0;
}

/**
 * Group messages into coherent blocks:
 * - An assistant message with tool_calls + subsequent tool result messages = one block
 * - Standalone user/assistant messages = individual blocks
 */
function groupMessageBlocks(messages: Message[]): Message[][] {
  const blocks: Message[][] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      // Group: assistant (with tool calls) + following tool results
      const block: Message[] = [msg];
      const toolCallIds = new Set(msg.toolCalls.map((tc) => tc.id));
      let j = i + 1;

      while (j < messages.length && messages[j].role === 'tool' && messages[j].toolCallId && toolCallIds.has(messages[j].toolCallId!)) {
        block.push(messages[j]);
        j++;
      }

      blocks.push(block);
      i = j;
    } else {
      blocks.push([msg]);
      i++;
    }
  }

  return blocks;
}
