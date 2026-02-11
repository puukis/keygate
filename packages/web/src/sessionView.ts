export type SessionChannelType = 'web' | 'discord' | 'terminal';

export interface SessionAttachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  url: string;
}

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: SessionAttachment[];
  timestamp: Date;
}

export interface SessionMeta {
  channelType: SessionChannelType;
  updatedAt: Date;
}

export interface SessionSnapshotMessage {
  role: 'user' | 'assistant';
  content: string;
  attachments?: SessionAttachment[];
}

export interface SessionSnapshotEntry {
  sessionId: string;
  channelType: SessionChannelType;
  updatedAt: Date;
  messages: SessionSnapshotMessage[];
}

export interface SessionChatState {
  messagesBySession: Record<string, SessionMessage[]>;
  metaBySession: Record<string, SessionMeta>;
  streamingBySession: Record<string, boolean>;
  streamBuffersBySession: Record<string, string>;
}

export const EMPTY_SESSION_CHAT_STATE: SessionChatState = {
  messagesBySession: {},
  metaBySession: {},
  streamingBySession: {},
  streamBuffersBySession: {},
};

export type SessionChatEvent =
  | {
    type: 'session_snapshot';
    sessions: SessionSnapshotEntry[];
  }
  | {
    type: 'session_stream_start';
    sessionId: string;
    channelType: SessionChannelType;
    timestamp: Date;
  }
  | {
    type: 'session_touch';
    sessionId: string;
    channelType: SessionChannelType;
    updatedAt: Date;
  }
  | {
    type: 'session_clear';
    sessionId: string;
    updatedAt: Date;
  }
  | {
    type: 'session_user_message';
    sessionId: string;
    channelType: SessionChannelType;
    content: string;
    attachments?: SessionAttachment[];
    timestamp: Date;
  }
  | {
    type: 'session_chunk';
    sessionId: string;
    content: string;
    timestamp: Date;
  }
  | {
    type: 'session_message_end';
    sessionId: string;
    content: string;
    timestamp: Date;
  };

export interface SessionOption {
  sessionId: string;
  label: string;
  channelType: SessionChannelType;
  updatedAt: Date;
  readOnly: boolean;
}

function inferChannelType(sessionId: string): SessionChannelType {
  if (sessionId.startsWith('discord:')) {
    return 'discord';
  }

  if (sessionId.startsWith('terminal:')) {
    return 'terminal';
  }

  return 'web';
}

function buildMessageId(
  sessionId: string,
  role: 'user' | 'assistant',
  timestamp: Date,
  indexHint: number
): string {
  return `${sessionId}:${role}:${timestamp.getTime()}:${indexHint}`;
}

export function reduceSessionChatState(state: SessionChatState, event: SessionChatEvent): SessionChatState {
  switch (event.type) {
    case 'session_snapshot': {
      const nextMessages = { ...state.messagesBySession };
      const nextMeta = { ...state.metaBySession };
      const nextStreaming = { ...state.streamingBySession };
      const nextBuffers = { ...state.streamBuffersBySession };

      for (const session of event.sessions) {
        nextMeta[session.sessionId] = {
          channelType: session.channelType,
          updatedAt: new Date(session.updatedAt),
        };

        if (state.streamingBySession[session.sessionId] === true) {
          continue;
        }

        nextMessages[session.sessionId] = session.messages.map((message, index) => ({
          id: `snapshot:${session.sessionId}:${index}`,
          role: message.role,
          content: message.content,
          attachments: message.attachments,
          timestamp: new Date(session.updatedAt),
        }));

        nextStreaming[session.sessionId] = false;
        nextBuffers[session.sessionId] = '';
      }

      return {
        messagesBySession: nextMessages,
        metaBySession: nextMeta,
        streamingBySession: nextStreaming,
        streamBuffersBySession: nextBuffers,
      };
    }

    case 'session_stream_start': {
      const prevMessages = state.messagesBySession[event.sessionId] ?? [];
      const lastMessage = prevMessages[prevMessages.length - 1];
      const nextMessages =
        lastMessage?.id === 'streaming' && lastMessage.role === 'assistant'
          ? prevMessages.slice(0, -1)
          : prevMessages;

      return {
        messagesBySession: {
          ...state.messagesBySession,
          [event.sessionId]: nextMessages,
        },
        metaBySession: {
          ...state.metaBySession,
          [event.sessionId]: {
            channelType: event.channelType,
            updatedAt: new Date(event.timestamp),
          },
        },
        streamingBySession: {
          ...state.streamingBySession,
          [event.sessionId]: true,
        },
        streamBuffersBySession: {
          ...state.streamBuffersBySession,
          [event.sessionId]: '',
        },
      };
    }

    case 'session_touch': {
      return {
        ...state,
        metaBySession: {
          ...state.metaBySession,
          [event.sessionId]: {
            channelType: event.channelType,
            updatedAt: new Date(event.updatedAt),
          },
        },
      };
    }

    case 'session_clear': {
      const channelType = state.metaBySession[event.sessionId]?.channelType ?? inferChannelType(event.sessionId);
      return {
        messagesBySession: {
          ...state.messagesBySession,
          [event.sessionId]: [],
        },
        metaBySession: {
          ...state.metaBySession,
          [event.sessionId]: {
            channelType,
            updatedAt: new Date(event.updatedAt),
          },
        },
        streamingBySession: {
          ...state.streamingBySession,
          [event.sessionId]: false,
        },
        streamBuffersBySession: {
          ...state.streamBuffersBySession,
          [event.sessionId]: '',
        },
      };
    }

    case 'session_user_message': {
      const prevMessages = state.messagesBySession[event.sessionId] ?? [];
      const nextMessage = {
        id: buildMessageId(event.sessionId, 'user', event.timestamp, prevMessages.length),
        role: 'user' as const,
        content: event.content,
        attachments: event.attachments,
        timestamp: new Date(event.timestamp),
      };

      return {
        messagesBySession: {
          ...state.messagesBySession,
          [event.sessionId]: [...prevMessages, nextMessage],
        },
        metaBySession: {
          ...state.metaBySession,
          [event.sessionId]: {
            channelType: event.channelType,
            updatedAt: new Date(event.timestamp),
          },
        },
        streamingBySession: state.streamingBySession,
        streamBuffersBySession: state.streamBuffersBySession,
      };
    }

    case 'session_chunk': {
      const channelType = state.metaBySession[event.sessionId]?.channelType ?? inferChannelType(event.sessionId);
      const previousBuffer = state.streamBuffersBySession[event.sessionId] ?? '';
      const nextBuffer = previousBuffer + event.content;
      const prevMessages = state.messagesBySession[event.sessionId] ?? [];
      const last = prevMessages[prevMessages.length - 1];

      const nextMessages =
        last?.id === 'streaming' && last.role === 'assistant'
          ? [...prevMessages.slice(0, -1), { ...last, content: nextBuffer, timestamp: new Date(event.timestamp) }]
          : [
            ...prevMessages,
            {
              id: 'streaming',
              role: 'assistant' as const,
              content: nextBuffer,
              timestamp: new Date(event.timestamp),
            },
          ];

      return {
        messagesBySession: {
          ...state.messagesBySession,
          [event.sessionId]: nextMessages,
        },
        metaBySession: {
          ...state.metaBySession,
          [event.sessionId]: {
            channelType,
            updatedAt: new Date(event.timestamp),
          },
        },
        streamingBySession: {
          ...state.streamingBySession,
          [event.sessionId]: true,
        },
        streamBuffersBySession: {
          ...state.streamBuffersBySession,
          [event.sessionId]: nextBuffer,
        },
      };
    }

    case 'session_message_end': {
      const channelType = state.metaBySession[event.sessionId]?.channelType ?? inferChannelType(event.sessionId);
      const prevMessages = state.messagesBySession[event.sessionId] ?? [];
      const last = prevMessages[prevMessages.length - 1];
      const fromStreamBuffer = state.streamBuffersBySession[event.sessionId]?.trim() ?? '';
      const finalizedContent = event.content.trim().length > 0
        ? event.content
        : (fromStreamBuffer.length > 0 ? fromStreamBuffer : '(No response)');

      const nextMessages =
        last?.id === 'streaming' && last.role === 'assistant'
          ? [
            ...prevMessages.slice(0, -1),
            {
              id: buildMessageId(event.sessionId, 'assistant', event.timestamp, prevMessages.length),
              role: 'assistant' as const,
              content: finalizedContent,
              timestamp: new Date(event.timestamp),
            },
          ]
          : [
            ...prevMessages,
            {
              id: buildMessageId(event.sessionId, 'assistant', event.timestamp, prevMessages.length),
              role: 'assistant' as const,
              content: finalizedContent,
              timestamp: new Date(event.timestamp),
            },
          ];

      return {
        messagesBySession: {
          ...state.messagesBySession,
          [event.sessionId]: nextMessages,
        },
        metaBySession: {
          ...state.metaBySession,
          [event.sessionId]: {
            channelType,
            updatedAt: new Date(event.timestamp),
          },
        },
        streamingBySession: {
          ...state.streamingBySession,
          [event.sessionId]: false,
        },
        streamBuffersBySession: {
          ...state.streamBuffersBySession,
          [event.sessionId]: '',
        },
      };
    }

    default:
      return state;
  }
}

export function buildSessionOptions(
  mainSessionId: string | null,
  metaBySession: Record<string, SessionMeta>
): SessionOption[] {
  const mainOption = mainSessionId && metaBySession[mainSessionId]
    ? [{
      sessionId: mainSessionId,
      label: 'main:agent',
      channelType: metaBySession[mainSessionId].channelType,
      updatedAt: metaBySession[mainSessionId].updatedAt,
      readOnly: false,
    } satisfies SessionOption]
    : [];

  const readOnlyEntries = Object.entries(metaBySession)
    .filter(([sessionId]) => sessionId !== mainSessionId)
    .sort((left, right) => {
      const timeDiff = right[1].updatedAt.getTime() - left[1].updatedAt.getTime();
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return left[0].localeCompare(right[0]);
    });

  let discordIndex = 0;
  let terminalIndex = 0;
  const readOnlyOptions = readOnlyEntries.map(([sessionId, meta]) => {
    const label = meta.channelType === 'discord'
      ? `discord:agent-${++discordIndex}`
      : meta.channelType === 'terminal'
        ? `terminal:agent-${++terminalIndex}`
        : `web:agent`;

    return ({
    sessionId,
    label,
    channelType: meta.channelType,
    updatedAt: meta.updatedAt,
    readOnly: true,
    } satisfies SessionOption);
  });

  return [...mainOption, ...readOnlyOptions];
}

export function isSessionReadOnly(selectedSessionId: string | null, mainSessionId: string | null): boolean {
  if (!selectedSessionId || !mainSessionId) {
    return false;
  }

  return selectedSessionId !== mainSessionId;
}

export function isComposerDisabled(
  connected: boolean,
  isStreaming: boolean,
  selectedSessionId: string | null,
  mainSessionId: string | null
): boolean {
  if (!selectedSessionId || !mainSessionId) {
    return true;
  }

  return !connected || isStreaming || isSessionReadOnly(selectedSessionId, mainSessionId);
}
