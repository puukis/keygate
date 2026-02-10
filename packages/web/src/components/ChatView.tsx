import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message, StreamActivity } from '../App';
import { buildScreenshotImageUrl, extractScreenshotFilenamesFromText } from '../browserPreview';
import { parseMessageSegments } from './messageContent';
import './ChatView.css';

interface ChatViewProps {
  messages: Message[];
  onSendMessage: (content: string) => void;
  isStreaming: boolean;
  streamActivities: StreamActivity[];
  disabled: boolean;
  inputPlaceholder: string;
  readOnlyHint?: string;
}

interface MessageRowProps {
  msg: Message;
  copiedCodeBlockId: string | null;
  onCopyCode: (blockId: string, code: string) => Promise<void> | void;
}

const STARTER_PROMPTS = [
  'Summarize the latest project changes and open tasks.',
  'Check the repo for security risks and suggest quick fixes.',
  'Write a deployment checklist for today\'s release.',
  'Draft a concise standup update from current progress.',
];

const AUTO_SCROLL_THRESHOLD_PX = 80;

function isNearBottom(container: HTMLDivElement): boolean {
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  return distanceFromBottom <= AUTO_SCROLL_THRESHOLD_PX;
}

export function ChatView({
  messages,
  onSendMessage,
  isStreaming,
  streamActivities,
  disabled,
  inputPlaceholder,
  readOnlyHint,
}: ChatViewProps) {
  const [input, setInput] = useState('');
  const [copiedCodeBlockId, setCopiedCodeBlockId] = useState<string | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const copyResetTimeoutRef = useRef<number | null>(null);
  const hasStreamingMessage = messages.some((msg) => msg.id === 'streaming');
  const visibleActivities = streamActivities.slice(-4).reverse();
  const currentActivity = visibleActivities[0];

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || !shouldAutoScrollRef.current) {
      return;
    }

    container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
  }, [messages, isStreaming]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) {
      return;
    }

    const handleScroll = () => {
      shouldAutoScrollRef.current = isNearBottom(container);
    };

    handleScroll();
    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const content = input.trim();
    if (!content || disabled || isStreaming) {
      return;
    }

    onSendMessage(content);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleStarterPrompt = (prompt: string) => {
    if (disabled || isStreaming) {
      return;
    }

    setInput(prompt);
    inputRef.current?.focus();
  };

  const handleCopyCode = async (blockId: string, code: string) => {
    const copied = await copyTextToClipboard(code);
    if (!copied) {
      return;
    }

    setCopiedCodeBlockId(blockId);
    if (copyResetTimeoutRef.current !== null) {
      window.clearTimeout(copyResetTimeoutRef.current);
    }

    copyResetTimeoutRef.current = window.setTimeout(() => {
      setCopiedCodeBlockId(null);
      copyResetTimeoutRef.current = null;
    }, 1500);
  };

  return (
    <div className="chat-view">
      {readOnlyHint && (
        <div className="chat-readonly-banner">
          {readOnlyHint}
        </div>
      )}
      <div className="messages-container" ref={messagesContainerRef}>
        {messages.length === 0 ? (
          <div className="empty-state animate-slide-in">
            <p className="empty-kicker">Ready</p>
            <h2>Talk to your AI workspace</h2>
            <p className="empty-copy">
              Use natural language to run tools, inspect files, and coordinate work in one place.
            </p>
            <div className="starter-grid">
              {STARTER_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="starter-chip"
                  onClick={() => handleStarterPrompt(prompt)}
                  disabled={disabled || isStreaming}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg) => (
              <MessageRow
                key={msg.id}
                msg={msg}
                copiedCodeBlockId={copiedCodeBlockId}
                onCopyCode={handleCopyCode}
              />
            ))}

            {isStreaming && !hasStreamingMessage && (
              <div className="message assistant animate-slide-in thinking-message">
                <div className="message-avatar" aria-hidden="true">K</div>
                <div className="message-content">
                  <div className="message-header">
                    <span className="message-role">Keygate</span>
                    <span className="thinking-badge">
                      {currentActivity ? 'Live' : 'Thinking'}
                    </span>
                  </div>
                  <div className="message-bubble thinking-bubble">
                    <div className="thinking-status">
                      {currentActivity?.status ?? 'Working on your request'}
                      {!currentActivity && (
                        <span className="thinking-dots" aria-hidden="true">
                          <span>.</span>
                          <span>.</span>
                          <span>.</span>
                        </span>
                      )}
                    </div>
                    {currentActivity?.detail && (
                      <div className="thinking-detail">{currentActivity.detail}</div>
                    )}
                    {visibleActivities.length > 1 && (
                      <div className="thinking-activity-list">
                        {visibleActivities.slice(1).map((activity) => (
                          <div key={activity.id} className="thinking-activity-item">
                            <span className="thinking-activity-time">
                              {activity.timestamp.toLocaleTimeString()}
                            </span>
                            <span>{activity.status}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <form className="input-container" onSubmit={handleSubmit}>
        <div className="composer-field">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={inputPlaceholder}
            disabled={disabled || isStreaming}
            rows={1}
          />
          <p className="composer-tip">Press Enter to send, Shift+Enter for a new line.</p>
        </div>
        <button
          type="submit"
          disabled={!input.trim() || disabled || isStreaming}
          className="send-btn"
        >
          {isStreaming ? (
            <span className="spinner" />
          ) : (
            <span>Send</span>
          )}
        </button>
      </form>
    </div>
  );
}

function MessageRow({ msg, copiedCodeBlockId, onCopyCode }: MessageRowProps) {
  const renderedScreenshotFilenames = new Set<string>();

  return (
    <div className={`message ${msg.role} animate-slide-in`}>
      <div className="message-avatar" aria-hidden="true">
        {msg.role === 'user' ? 'U' : 'K'}
      </div>
      <div className="message-content">
        <div className="message-header">
          <span className="message-role">
            {msg.role === 'user' ? 'You' : 'Keygate'}
          </span>
          <span className="message-time">
            {msg.timestamp.toLocaleTimeString()}
          </span>
        </div>
        <div className="message-bubble">
          <div className="message-rendered">
            {parseMessageSegments(msg.content).map((segment, segmentIndex) => {
              const key = `${msg.id}:${segmentIndex}`;
              if (segment.type === 'text') {
                if (segment.content.length === 0) {
                  return null;
                }

                const screenshotRefs = (msg.role === 'assistant'
                  ? extractScreenshotFilenamesFromText(segment.content)
                  : [])
                  .filter((screenshotRef) => {
                    const dedupeKey = screenshotRef.filename.toLowerCase();
                    if (renderedScreenshotFilenames.has(dedupeKey)) {
                      return false;
                    }

                    renderedScreenshotFilenames.add(dedupeKey);
                    return true;
                  });

                return (
                  <div key={key} className="message-text">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ node: _node, ...props }) => (
                          <a {...props} target="_blank" rel="noreferrer noopener" />
                        ),
                      }}
                    >
                      {segment.content}
                    </ReactMarkdown>
                    {screenshotRefs.length > 0 && (
                      <div className="message-screenshot-list">
                        {screenshotRefs.map((screenshotRef) => {
                          const screenshotUrl = buildScreenshotImageUrl(screenshotRef.filename);
                          return (
                            <span
                              key={`${msg.id}:${segmentIndex}:${screenshotRef.filename}`}
                              className="message-screenshot-inline"
                            >
                              <a
                                href={screenshotUrl}
                                target="_blank"
                                rel="noreferrer noopener"
                              >
                                {screenshotRef.filename}
                              </a>
                              <img
                                src={screenshotUrl}
                                alt={`Browser screenshot for ${screenshotRef.sessionId}`}
                                className="message-screenshot-image"
                                loading="lazy"
                              />
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              }

              const blockId = `${msg.id}:code:${segmentIndex}`;
              return (
                <div key={key} className="code-block">
                  <div className="code-block-header">
                    <span className="code-block-language">
                      {segment.language ?? 'text'}
                    </span>
                    <button
                      type="button"
                      className="code-copy-btn"
                      onClick={() => onCopyCode(blockId, segment.content)}
                    >
                      {copiedCodeBlockId === blockId ? 'Copied' : 'Copy code'}
                    </button>
                  </div>
                  <pre>
                    <code>{segment.content}</code>
                  </pre>
                </div>
              );
            })}
          </div>
          {msg.id === 'streaming' && (
            <span className="cursor-blink">|</span>
          )}
        </div>
      </div>
    </div>
  );
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below.
    }
  }

  if (typeof document === 'undefined') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }

  return copied;
}
