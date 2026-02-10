import { describe, expect, it } from 'vitest';
import { EMPTY_SESSION_CHAT_STATE, reduceSessionChatState } from './sessionView';

describe('reduceSessionChatState session_message_end', () => {
  it('prefers final event content over streamed buffer when non-empty', () => {
    const sessionId = 'main:agent';
    const streamStart = new Date('2026-02-08T10:00:00.000Z');
    const streamChunk = new Date('2026-02-08T10:00:01.000Z');
    const streamEnd = new Date('2026-02-08T10:00:02.000Z');

    let state = EMPTY_SESSION_CHAT_STATE;
    state = reduceSessionChatState(state, {
      type: 'session_stream_start',
      sessionId,
      channelType: 'web',
      timestamp: streamStart,
    });
    state = reduceSessionChatState(state, {
      type: 'session_chunk',
      sessionId,
      content: 'Current capabilities in this workspace: - Read files - Run commands',
      timestamp: streamChunk,
    });
    state = reduceSessionChatState(state, {
      type: 'session_message_end',
      sessionId,
      content: 'Current capabilities in this workspace:\n- Read files\n- Run commands',
      timestamp: streamEnd,
    });

    const messages = state.messagesBySession[sessionId] ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('Current capabilities in this workspace:\n- Read files\n- Run commands');
    expect(state.streamingBySession[sessionId]).toBe(false);
    expect(state.streamBuffersBySession[sessionId]).toBe('');
  });

  it('falls back to streamed buffer when final event content is empty', () => {
    const sessionId = 'main:agent';
    const streamStart = new Date('2026-02-08T11:00:00.000Z');
    const streamChunk = new Date('2026-02-08T11:00:01.000Z');
    const streamEnd = new Date('2026-02-08T11:00:02.000Z');

    let state = EMPTY_SESSION_CHAT_STATE;
    state = reduceSessionChatState(state, {
      type: 'session_stream_start',
      sessionId,
      channelType: 'web',
      timestamp: streamStart,
    });
    state = reduceSessionChatState(state, {
      type: 'session_chunk',
      sessionId,
      content: 'streamed fallback text',
      timestamp: streamChunk,
    });
    state = reduceSessionChatState(state, {
      type: 'session_message_end',
      sessionId,
      content: '   ',
      timestamp: streamEnd,
    });

    const messages = state.messagesBySession[sessionId] ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('streamed fallback text');
  });

  it('infers terminal channel type from terminal-prefixed session id', () => {
    const state = reduceSessionChatState(EMPTY_SESSION_CHAT_STATE, {
      type: 'session_clear',
      sessionId: 'terminal:alpha',
      updatedAt: new Date('2026-02-08T11:00:00.000Z'),
    });

    expect(state.metaBySession['terminal:alpha']?.channelType).toBe('terminal');
  });
});
