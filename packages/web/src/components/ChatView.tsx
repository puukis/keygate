import { useState, useRef, useEffect } from 'react';
import type { Message, StreamActivity } from '../App';
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const hasStreamingMessage = messages.some((msg) => msg.id === 'streaming');
  const visibleActivities = streamActivities.slice(-4).reverse();
  const currentActivity = visibleActivities[0];

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
                    {msg.content}
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
