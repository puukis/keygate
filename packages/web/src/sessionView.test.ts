import { describe, expect, it } from 'vitest';
import { EMPTY_SESSION_CHAT_STATE, reduceSessionChatState, buildSessionOptions, isSessionReadOnly } from './sessionView';

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

  it('preserves attachments from session snapshot entries', () => {
    const state = reduceSessionChatState(EMPTY_SESSION_CHAT_STATE, {
      type: 'session_snapshot',
      sessions: [{
        sessionId: 'web:main',
        channelType: 'web',
        updatedAt: new Date('2026-02-08T12:00:00.000Z'),
        messages: [{
          role: 'user',
          content: 'analyze this image',
          attachments: [{
            id: 'att-1',
            filename: 'photo.png',
            contentType: 'image/png',
            sizeBytes: 1234,
            url: '/api/uploads/image?sessionId=web%3Amain&id=att-1',
          }],
        }],
      }],
    });

    const messages = state.messagesBySession['web:main'] ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.attachments).toEqual([{
      id: 'att-1',
      filename: 'photo.png',
      contentType: 'image/png',
      sizeBytes: 1234,
      url: '/api/uploads/image?sessionId=web%3Amain&id=att-1',
    }]);
  });

  it('preserves attachments from session_user_message events', () => {
    const state = reduceSessionChatState(EMPTY_SESSION_CHAT_STATE, {
      type: 'session_user_message',
      sessionId: 'web:main',
      channelType: 'web',
      content: '',
      attachments: [{
        id: 'att-2',
        filename: 'diagram.webp',
        contentType: 'image/webp',
        sizeBytes: 512,
        url: '/api/uploads/image?sessionId=web%3Amain&id=att-2',
      }],
      timestamp: new Date('2026-02-08T13:00:00.000Z'),
    });

    const messages = state.messagesBySession['web:main'] ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.attachments?.[0]?.id).toBe('att-2');
  });
});

describe('buildSessionOptions', () => {
  it('uses session title as label when available', () => {
    const options = buildSessionOptions('web:main', {
      'web:main': { channelType: 'web', title: 'My Chat', updatedAt: new Date() },
    });

    expect(options).toHaveLength(1);
    expect(options[0]?.label).toBe('My Chat');
  });

  it('falls back to default label when title is empty', () => {
    const options = buildSessionOptions('web:main', {
      'web:main': { channelType: 'web', updatedAt: new Date() },
    });

    expect(options[0]?.label).toBe('main:agent');
  });

  it('marks non-main web sessions as writable', () => {
    const options = buildSessionOptions('web:main', {
      'web:main': { channelType: 'web', updatedAt: new Date() },
      'web:other': { channelType: 'web', updatedAt: new Date() },
    });

    const other = options.find((o) => o.sessionId === 'web:other');
    expect(other?.readOnly).toBe(false);
  });

  it('marks discord sessions as read-only', () => {
    const options = buildSessionOptions('web:main', {
      'web:main': { channelType: 'web', updatedAt: new Date() },
      'discord:123': { channelType: 'discord', updatedAt: new Date() },
    });

    const discord = options.find((o) => o.sessionId === 'discord:123');
    expect(discord?.readOnly).toBe(true);
  });
});

describe('isSessionReadOnly', () => {
  it('returns false for web sessions', () => {
    expect(isSessionReadOnly('web:other', 'web:main')).toBe(false);
  });

  it('returns true for discord sessions', () => {
    expect(isSessionReadOnly('discord:123', 'web:main')).toBe(true);
  });

  it('returns true for terminal sessions', () => {
    expect(isSessionReadOnly('terminal:abc', 'web:main')).toBe(true);
  });

  it('returns false when selectedSessionId is null', () => {
    expect(isSessionReadOnly(null, 'web:main')).toBe(false);
  });
});
