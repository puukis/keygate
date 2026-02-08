import { describe, expect, it } from 'vitest';
import {
  buildSessionOptions,
  EMPTY_SESSION_CHAT_STATE,
  isComposerDisabled,
  reduceSessionChatState,
} from '../src/sessionView';

function asDate(value: string): Date {
  return new Date(value);
}

describe('buildSessionOptions', () => {
  it('renders main first and labels discord sessions by recency', () => {
    const options = buildSessionOptions('web:main', {
      'web:main': { channelType: 'web', updatedAt: asDate('2026-02-08T12:00:00.000Z') },
      'discord:b': { channelType: 'discord', updatedAt: asDate('2026-02-08T12:05:00.000Z') },
      'discord:a': { channelType: 'discord', updatedAt: asDate('2026-02-08T12:01:00.000Z') },
    });

    expect(options.map((option) => option.label)).toEqual([
      'main:agent',
      'discord:agent-1',
      'discord:agent-2',
    ]);
    expect(options.map((option) => option.sessionId)).toEqual([
      'web:main',
      'discord:b',
      'discord:a',
    ]);
  });
});

describe('reduceSessionChatState snapshot + streaming flow', () => {
  it('hydrates snapshot sessions and updates stream chunk/end deterministically', () => {
    const snapshotState = reduceSessionChatState(EMPTY_SESSION_CHAT_STATE, {
      type: 'session_snapshot',
      sessions: [
        {
          sessionId: 'web:main',
          channelType: 'web',
          updatedAt: asDate('2026-02-08T13:00:00.000Z'),
          messages: [{ role: 'assistant', content: 'ready' }],
        },
        {
          sessionId: 'discord:42',
          channelType: 'discord',
          updatedAt: asDate('2026-02-08T13:01:00.000Z'),
          messages: [{ role: 'user', content: 'hello from discord' }],
        },
      ],
    });

    expect(snapshotState.messagesBySession['web:main']?.[0]?.content).toBe('ready');
    expect(snapshotState.messagesBySession['discord:42']?.[0]?.role).toBe('user');

    const chunkedState = reduceSessionChatState(snapshotState, {
      type: 'session_chunk',
      sessionId: 'web:main',
      content: 'partial',
      timestamp: asDate('2026-02-08T13:02:00.000Z'),
    });

    expect(chunkedState.streamingBySession['web:main']).toBe(true);
    expect(chunkedState.messagesBySession['web:main']?.at(-1)?.id).toBe('streaming');
    expect(chunkedState.messagesBySession['web:main']?.at(-1)?.content).toBe('partial');

    const endedState = reduceSessionChatState(chunkedState, {
      type: 'session_message_end',
      sessionId: 'web:main',
      content: 'ignored because stream buffer exists',
      timestamp: asDate('2026-02-08T13:03:00.000Z'),
    });

    expect(endedState.streamingBySession['web:main']).toBe(false);
    expect(endedState.messagesBySession['web:main']?.at(-1)?.id).not.toBe('streaming');
    expect(endedState.messagesBySession['web:main']?.at(-1)?.content).toBe('partial');
  });

  it('appends user messages with channel metadata', () => {
    const state = reduceSessionChatState(EMPTY_SESSION_CHAT_STATE, {
      type: 'session_user_message',
      sessionId: 'discord:9',
      channelType: 'discord',
      content: 'test',
      timestamp: asDate('2026-02-08T14:00:00.000Z'),
    });

    expect(state.messagesBySession['discord:9']?.[0]?.role).toBe('user');
    expect(state.metaBySession['discord:9']?.channelType).toBe('discord');
  });

  it('marks session as streaming on stream start before first chunk', () => {
    const state = reduceSessionChatState(EMPTY_SESSION_CHAT_STATE, {
      type: 'session_stream_start',
      sessionId: 'web:main',
      channelType: 'web',
      timestamp: asDate('2026-02-08T15:00:00.000Z'),
    });

    expect(state.streamingBySession['web:main']).toBe(true);
    expect(state.streamBuffersBySession['web:main']).toBe('');
    expect(state.metaBySession['web:main']?.channelType).toBe('web');
  });
});

describe('isComposerDisabled', () => {
  it('disables composer for discord selection and keeps main writable', () => {
    expect(isComposerDisabled(true, false, 'discord:1', 'web:main')).toBe(true);
    expect(isComposerDisabled(true, false, 'web:main', 'web:main')).toBe(false);
    expect(isComposerDisabled(false, false, 'web:main', 'web:main')).toBe(true);
    expect(isComposerDisabled(true, false, null, null)).toBe(true);
  });
});
