import { useState, useRef, useEffect } from 'react';
import type { Message, StreamActivity } from '../App';
import './ChatView.css';

interface ChatViewProps {
  messages: Message[];
  onSendMessage: (content: string) => void;
  isStreaming: boolean;
  streamActivities: StreamActivity[];
  disabled: boolean;
}

export function ChatView({ messages, onSendMessage, isStreaming, streamActivities, disabled }: ChatViewProps) {
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
    if (!input.trim() || disabled || isStreaming) return;
    onSendMessage(input);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="chat-view">
      <div className="messages-container">
        {messages.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">⚡</div>
            <h2>Welcome to Keygate</h2>
            <p>Your personal AI agent gateway. Ask me to:</p>
            <ul>
              <li>Read and write files</li>
              <li>Run terminal commands</li>
              <li>Execute code (JavaScript/Python)</li>
              <li>Search the web</li>
              <li>Automate browser tasks</li>
            </ul>
          </div>
        ) : (
          <>
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`message ${msg.role} animate-slide-in`}
              >
                <div className="message-avatar">
                  {msg.role === 'user' ? '👤' : '🤖'}
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
                  <div className="message-text">
                    {msg.content}
                    {msg.id === 'streaming' && (
                      <span className="cursor-blink">▋</span>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {isStreaming && !hasStreamingMessage && (
              <div className="message assistant animate-slide-in thinking-message">
                <div className="message-avatar">🤖</div>
                <div className="message-content">
                  <div className="message-header">
                    <span className="message-role">Keygate</span>
                    <span className="thinking-badge">
                      {currentActivity ? 'Live' : 'Thinking'}
                    </span>
                  </div>
                  <div className="message-text thinking-text">
                    <div className="thinking-status">
                      {currentActivity?.status ?? 'Working on it'}
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
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? 'Connecting...' : 'Ask Keygate anything...'}
          disabled={disabled || isStreaming}
          rows={1}
        />
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
