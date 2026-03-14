import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChatView } from './components/ChatView';
import { useWebSocket } from './hooks/useWebSocket';
import type { Message, StreamActivity } from './App';
import {
  applyResolvedTheme,
  getNextThemePreferenceForToggle,
  getSystemTheme,
  readThemePreference,
  resolveTheme,
  writeThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from './theme';
import './WebChatApp.css';

interface WebChatAttachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  url: string;
  kind?: 'image' | 'audio' | 'video' | 'pdf' | 'document' | 'unknown';
  previewText?: string;
}

interface SnapshotMessage {
  role: 'user' | 'assistant';
  content: string;
  attachments?: WebChatAttachment[];
}

interface WebChatPollVote {
  voterId: string;
  optionIds: string[];
}

interface WebChatPoll {
  id: string;
  question: string;
  options: string[];
  multiple: boolean;
  status: string;
  votes: WebChatPollVote[];
}

function getToken(): string {
  return new URLSearchParams(window.location.search).get('token')?.trim() ?? '';
}

function getWebSocketUrl(token: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/webchat/ws?token=${encodeURIComponent(token)}`;
}

function parseAttachments(value: unknown): WebChatAttachment[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const attachments = value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'].trim() : '';
    const filename = typeof record['filename'] === 'string' ? record['filename'].trim() : '';
    const contentType = typeof record['contentType'] === 'string' ? record['contentType'].trim() : '';
    const rawUrl = typeof record['url'] === 'string' ? record['url'].trim() : '';
    const url = rawUrl.startsWith('/api/uploads/')
      ? `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(getToken())}`
      : rawUrl;
    const sizeBytes = Number(record['sizeBytes'] ?? 0);
    if (!id || !filename || !contentType || !url || !Number.isFinite(sizeBytes)) {
      return [];
    }
    return [{
      id,
      filename,
      contentType,
      sizeBytes,
      url,
      kind: typeof record['kind'] === 'string' ? record['kind'] as WebChatAttachment['kind'] : undefined,
      previewText: typeof record['previewText'] === 'string' ? record['previewText'] : undefined,
    }];
  });

  return attachments.length > 0 ? attachments : undefined;
}

function parseSnapshot(value: unknown): SnapshotMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }

  const first = value[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return [];
  }
  const session = first as Record<string, unknown>;
  const messages = Array.isArray(session['messages']) ? session['messages'] : [];
  return messages.flatMap((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return [];
    }
    const record = message as Record<string, unknown>;
    const role = record['role'];
    if (role !== 'user' && role !== 'assistant') {
      return [];
    }
    return [{
      role,
      content: typeof record['content'] === 'string' ? record['content'] : '',
      attachments: parseAttachments(record['attachments']),
    }];
  });
}

function parsePolls(value: unknown): WebChatPoll[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'] : '';
    const question = typeof record['question'] === 'string' ? record['question'] : '';
    const options = Array.isArray(record['options'])
      ? record['options'].filter((entry): entry is string => typeof entry === 'string')
      : [];
    const votes = Array.isArray(record['votes'])
      ? record['votes'].flatMap((vote) => {
        if (!vote || typeof vote !== 'object' || Array.isArray(vote)) {
          return [];
        }
        const voteRecord = vote as Record<string, unknown>;
        const voterId = typeof voteRecord['voterId'] === 'string' ? voteRecord['voterId'] : '';
        const optionIds = Array.isArray(voteRecord['optionIds'])
          ? voteRecord['optionIds'].filter((entry): entry is string => typeof entry === 'string')
          : [];
        return voterId ? [{ voterId, optionIds }] : [];
      })
      : [];

    if (!id || !question || options.length < 2) {
      return [];
    }

    return [{
      id,
      question,
      options,
      multiple: record['multiple'] === true,
      status: typeof record['status'] === 'string' ? record['status'] : 'open',
      votes,
    }];
  });
}

export function WebChatApp() {
  const token = useMemo(() => getToken(), []);
  const [sessionId, setSessionId] = useState<string>('');
  const [displayName, setDisplayName] = useState('Guest');
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [connectedOnce, setConnectedOnce] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentStream, setCurrentStream] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [polls, setPolls] = useState<WebChatPoll[]>([]);
  const [localVotes, setLocalVotes] = useState<Record<string, string[]>>({});
  const streamActivities: StreamActivity[] = [];

  // ── Theme management ──────────────────────────────────────
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readThemePreference());
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => getSystemTheme());
  const resolvedTheme = resolveTheme(themePreference, systemTheme);

  useEffect(() => {
    applyResolvedTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const handleThemeToggle = useCallback(() => {
    const next = getNextThemePreferenceForToggle(themePreference, resolvedTheme);
    setThemePreference(next);
    writeThemePreference(next);
  }, [themePreference, resolvedTheme]);

  const refreshPolls = useCallback(async () => {
    if (!token) {
      return;
    }
    try {
      const response = await fetch(`/webchat/polls?token=${encodeURIComponent(token)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) {
        return;
      }
      const payload = await response.json() as { polls?: unknown };
      setPolls(parsePolls(payload.polls));
    } catch {
      // Ignore background poll refresh failures.
    }
  }, [token]);

  const { send, connected, connecting } = useWebSocket(
    token ? getWebSocketUrl(token) : 'ws://127.0.0.1/invalid',
    (data) => {
      const type = typeof data['type'] === 'string' ? data['type'] : '';
      switch (type) {
        case 'connected': {
          setConnectedOnce(true);
          setSessionId(typeof data['sessionId'] === 'string' ? data['sessionId'] : '');
          setDisplayName(typeof data['displayName'] === 'string' ? data['displayName'] : 'Guest');
          setExpiresAt(typeof data['expiresAt'] === 'string' ? data['expiresAt'] : null);
          setError(null);
          break;
        }

        case 'session_snapshot': {
          const snapshot = parseSnapshot(data['sessions']);
          setMessages(snapshot.map((message, index) => ({
            id: `snapshot:${index}`,
            role: message.role,
            content: message.content,
            attachments: message.attachments,
            timestamp: new Date(),
          })));
          setCurrentStream('');
          setIsStreaming(false);
          break;
        }

        case 'channel:poll': {
          void refreshPolls();
          break;
        }

        case 'channel:poll_vote': {
          const pollId = typeof data['pollId'] === 'string' ? data['pollId'] : '';
          const vote = data['vote'] && typeof data['vote'] === 'object' && !Array.isArray(data['vote'])
            ? data['vote'] as Record<string, unknown>
            : null;
          if (pollId && vote) {
            const optionIds = Array.isArray(vote['optionIds'])
              ? vote['optionIds'].filter((entry): entry is string => typeof entry === 'string')
              : [];
            setPolls((previous) => previous.map((poll) => {
              if (poll.id !== pollId) {
                return poll;
              }
              const voterId = typeof vote['voterId'] === 'string' ? vote['voterId'] : '';
              if (!voterId) {
                return poll;
              }
              const remaining = poll.votes.filter((entry) => entry.voterId !== voterId);
              return {
                ...poll,
                votes: [...remaining, { voterId, optionIds }],
              };
            }));
          }
          break;
        }

        case 'session_user_message': {
          const incomingSessionId = typeof data['sessionId'] === 'string' ? data['sessionId'] : '';
          if (sessionId && incomingSessionId !== sessionId) {
            break;
          }
          const content = typeof data['content'] === 'string' ? data['content'] : '';
          setMessages((previous) => [...previous, {
            id: `user:${Date.now()}`,
            role: 'user',
            content,
            attachments: parseAttachments(data['attachments']),
            timestamp: new Date(),
          }]);
          break;
        }

        case 'message_received': {
          setIsStreaming(true);
          setCurrentStream('');
          break;
        }

        case 'session_chunk': {
          const content = typeof data['content'] === 'string' ? data['content'] : '';
          setIsStreaming(true);
          setCurrentStream((previous) => previous + content);
          break;
        }

        case 'session_message_end': {
          const content = typeof data['content'] === 'string' ? data['content'] : currentStream;
          setMessages((previous) => [...previous, {
            id: `assistant:${Date.now()}`,
            role: 'assistant',
            content,
            timestamp: new Date(),
          }]);
          setCurrentStream('');
          setIsStreaming(false);
          break;
        }

        case 'session_cancelled': {
          setIsStreaming(false);
          setCurrentStream('');
          break;
        }

        case 'error': {
          setError(typeof data['error'] === 'string' ? data['error'] : 'WebChat error');
          setIsStreaming(false);
          break;
        }

        default:
          break;
      }
    },
    {
      enabled: token.length > 0,
      onDisconnected: ({ everConnected }) => {
        if (everConnected) {
          setError('Connection lost. Reconnecting...');
        }
      },
    }
  );

  useEffect(() => {
    void refreshPolls();
  }, [refreshPolls]);

  const renderedMessages = isStreaming
    ? [...messages, {
      id: 'streaming',
      role: 'assistant' as const,
      content: currentStream,
      timestamp: new Date(),
    }]
    : messages;

  const connectionState = token.length === 0
    ? 'Missing token'
    : connecting && !connected
      ? 'Connecting'
      : connected
        ? 'Connected'
        : connectedOnce
          ? 'Reconnecting'
          : 'Waiting';

  const connClass = `webchat-conn webchat-conn-${connectionState.toLowerCase().replace(/\s+/g, '-')}`;

  return (
    <main className="webchat-shell">
      <header className="webchat-header">
        <div className="webchat-brand">
          <span className="webchat-brand-mark" aria-hidden="true" />
          <span className="webchat-brand-name">Keygate</span>
          <span className="webchat-brand-tag">WebChat</span>
        </div>
        <button
          type="button"
          className="webchat-theme-toggle"
          onClick={handleThemeToggle}
          aria-label={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {resolvedTheme === 'dark' ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="2" x2="12" y2="4" />
              <line x1="12" y1="20" x2="12" y2="22" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="2" y1="12" x2="4" y2="12" />
              <line x1="20" y1="12" x2="22" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>
      </header>

      <section className="webchat-hero">
        <p className="webchat-kicker">Guest Session</p>
        <h1>{displayName}</h1>
        <div className="webchat-rule" aria-hidden="true" />
        <p className="webchat-meta">
          <span className={connClass}>
            <span className="webchat-conn-dot" aria-hidden="true" />
            {connectionState}
          </span>
          {expiresAt && <span className="webchat-expires">Expires {new Date(expiresAt).toLocaleString()}</span>}
        </p>
        {error && <p className="webchat-error">{error}</p>}
      </section>

      <section className="webchat-panel">
        {polls.length > 0 && (
          <div className="webchat-polls">
            <h2>Live polls</h2>
            <div className="webchat-poll-list">
              {polls.map((poll) => {
                const selected = new Set(localVotes[poll.id] ?? []);
                const totalVotes = poll.votes.length;
                return (
                  <article key={poll.id} className="webchat-poll-card">
                    <header>
                      <strong>{poll.question}</strong>
                      <span>{poll.multiple ? 'Multi-select' : 'Single choice'} • {totalVotes} vote{totalVotes === 1 ? '' : 's'}</span>
                    </header>
                    <div className="webchat-poll-options">
                      {poll.options.map((option) => {
                        const count = poll.votes.filter((vote) => vote.optionIds.includes(option)).length;
                        const active = selected.has(option);
                        return (
                          <button
                            key={option}
                            type="button"
                            className={`webchat-poll-option ${active ? 'selected' : ''}`}
                            onClick={() => {
                              const next = poll.multiple
                                ? active
                                  ? Array.from(selected).filter((entry) => entry !== option)
                                  : [...Array.from(selected), option]
                                : [option];
                              setLocalVotes((previous) => ({
                                ...previous,
                                [poll.id]: next,
                              }));
                              const sent = send({
                                type: 'poll-vote',
                                pollId: poll.id,
                                optionIds: next,
                              });
                              if (!sent) {
                                setError('WebSocket is not connected.');
                              }
                            }}
                          >
                            <span>{option}</span>
                            <span>{count}</span>
                          </button>
                        );
                      })}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        )}
        <ChatView
          messages={renderedMessages}
          onSendMessage={(content, attachments) => {
            const sent = send({
              type: 'message',
              content,
              attachments,
            });
            if (!sent) {
              setError('WebSocket is not connected.');
            }
          }}
          onStop={() => {
            send({
              type: 'cancel_session',
              sessionId,
            });
          }}
          isStreaming={isStreaming}
          streamActivities={streamActivities}
          disabled={!connected || token.length === 0}
          inputPlaceholder="Send a message"
          sessionIdForUploads={sessionId}
          readOnlyHint={token.length === 0 ? 'This link is missing its guest token.' : undefined}
          uploadEndpoint={`/webchat/uploads/attachment?token=${encodeURIComponent(token)}`}
        />
      </section>
    </main>
  );
}
