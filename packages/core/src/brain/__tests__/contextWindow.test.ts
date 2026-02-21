import { describe, expect, it } from 'vitest';
import {
  estimateTokenCount,
  estimateMessageTokens,
  getContextWindowLimit,
  getContextUsage,
  truncateMessages,
} from '../contextWindow.js';
import type { Message } from '../../types.js';

describe('estimateTokenCount', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  it('estimates ~1 token per 4 characters', () => {
    const text = 'Hello, world!'; // 13 chars → ceil(13/4) = 4
    expect(estimateTokenCount(text)).toBe(4);
  });

  it('handles long text', () => {
    const text = 'a'.repeat(1000);
    expect(estimateTokenCount(text)).toBe(250);
  });
});

describe('estimateMessageTokens', () => {
  it('includes role overhead', () => {
    const msg: Message = { role: 'user', content: '' };
    // 4 base + 0 content = 4
    expect(estimateMessageTokens(msg)).toBe(4);
  });

  it('counts content tokens', () => {
    const msg: Message = { role: 'user', content: 'Hello, world!' };
    // 4 base + ceil(13/4) = 4 + 4 = 8
    expect(estimateMessageTokens(msg)).toBe(8);
  });

  it('counts tool call tokens', () => {
    const msg: Message = {
      role: 'assistant',
      content: 'thinking',
      toolCalls: [{
        id: 'call_1',
        name: 'read_file',
        arguments: { path: '/tmp/test.ts' },
      }],
    };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBeGreaterThan(10);
  });
});

describe('getContextWindowLimit', () => {
  it('returns known limit for gpt-4o', () => {
    expect(getContextWindowLimit('openai', 'gpt-4o')).toBe(128_000);
  });

  it('returns known limit for gemini-1.5-pro', () => {
    expect(getContextWindowLimit('gemini', 'gemini-1.5-pro')).toBe(1_048_576);
  });

  it('returns Infinity for openai-codex provider', () => {
    expect(getContextWindowLimit('openai-codex', 'gpt-5.3')).toBe(Infinity);
  });

  it('returns default for unknown model', () => {
    expect(getContextWindowLimit('ollama', 'custom-model-xyz')).toBe(32_768);
  });

  it('strips provider prefix from model', () => {
    expect(getContextWindowLimit('openai', 'openai/gpt-4o')).toBe(128_000);
  });

  it('matches model by prefix for versioned names', () => {
    expect(getContextWindowLimit('openai', 'gpt-4o-2024-05-13')).toBe(128_000);
  });
});

describe('getContextUsage', () => {
  it('returns percent 0 for empty messages', () => {
    const usage = getContextUsage([], 128_000);
    expect(usage.usedTokens).toBe(0);
    expect(usage.percent).toBe(0);
  });

  it('calculates usage correctly', () => {
    const messages: Message[] = [
      { role: 'system', content: 'x'.repeat(4000) },
      { role: 'user', content: 'x'.repeat(4000) },
    ];
    const usage = getContextUsage(messages, 10_000);
    expect(usage.usedTokens).toBeGreaterThan(0);
    expect(usage.percent).toBeGreaterThan(0);
    expect(usage.percent).toBeLessThanOrEqual(100);
  });

  it('returns all zeros for Infinity limit', () => {
    const messages: Message[] = [{ role: 'user', content: 'hello' }];
    const usage = getContextUsage(messages, Infinity);
    expect(usage.usedTokens).toBe(0);
    expect(usage.percent).toBe(0);
    expect(usage.availableTokens).toBe(Infinity);
  });
});

describe('truncateMessages', () => {
  function makeMessages(count: number, contentLength: number): Message[] {
    const messages: Message[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
    ];
    for (let i = 0; i < count; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i}: ${'x'.repeat(contentLength)}`,
      });
    }
    return messages;
  }

  it('returns messages unchanged when within limit', () => {
    const messages = makeMessages(4, 20);
    const result = truncateMessages(messages, 100_000);
    expect(result).toEqual(messages);
  });

  it('returns messages unchanged for Infinity limit', () => {
    const messages = makeMessages(100, 100);
    const result = truncateMessages(messages, Infinity);
    expect(result).toEqual(messages);
  });

  it('always keeps system message', () => {
    const messages = makeMessages(20, 200);
    const result = truncateMessages(messages, 6000);
    expect(result[0].role).toBe('system');
    expect(result[0].content).toBe('You are a helpful assistant.');
  });

  it('always keeps recent user turns', () => {
    const messages = makeMessages(20, 200);
    const result = truncateMessages(messages, 6000);
    const lastUserMsg = messages.filter((m) => m.role === 'user').pop()!;
    expect(result.some((m) => m.content === lastUserMsg.content)).toBe(true);
  });

  it('inserts a trimming notice when messages are dropped', () => {
    const messages = makeMessages(40, 500);
    const result = truncateMessages(messages, 8000);
    const notice = result.find((m) => m.role === 'system' && m.content.includes('trimmed'));
    expect(notice).toBeDefined();
  });

  it('keeps tool call + result pairs together', () => {
    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'old question' },
      {
        role: 'assistant',
        content: 'let me check',
        toolCalls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/tmp/a' } }],
      },
      { role: 'tool', content: 'file contents here', toolCallId: 'tc1' },
      { role: 'user', content: 'x'.repeat(100) },
      { role: 'assistant', content: 'response' },
      { role: 'user', content: 'latest question' },
    ];

    const result = truncateMessages(messages, 10_000);

    // If the tool call assistant is kept, its result must also be kept
    const hasToolCallAssistant = result.some(
      (m) => m.role === 'assistant' && m.toolCalls?.some((tc) => tc.id === 'tc1')
    );
    const hasToolResult = result.some(
      (m) => m.role === 'tool' && m.toolCallId === 'tc1'
    );

    if (hasToolCallAssistant) {
      expect(hasToolResult).toBe(true);
    }
  });

  it('result fits within the limit', () => {
    const messages = makeMessages(50, 400);
    const limit = 10_000;
    const result = truncateMessages(messages, limit);
    const totalTokens = result.reduce(
      (sum, m) => sum + estimateMessageTokens(m),
      0
    );
    // Should fit within limit minus output reserve (4096)
    expect(totalTokens).toBeLessThanOrEqual(limit - 4096);
  });
});
