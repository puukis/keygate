import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message, StreamActivity } from '../App';
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

const STARTER_PROMPTS = [
  'Summarize the latest project changes and open tasks.',
  'Check the repo for security risks and suggest quick fixes.',
  'Write a deployment checklist for today\'s release.',
  'Draft a concise standup update from current progress.',
];

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
  const messagesEndRef = useRef<HTMLDivElement>(null);
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
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

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
      <div className="messages-container">
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
              <div
                key={msg.id}
                className={`message ${msg.role} animate-slide-in`}
              >
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
                                onClick={() => handleCopyCode(blockId, segment.content)}
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
        <div ref={messagesEndRef} />
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
