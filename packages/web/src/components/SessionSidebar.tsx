import { useState, useCallback } from 'react';
import type { SessionOption } from '../sessionView';
import './SessionSidebar.css';

interface SessionSidebarProps {
  sessions: SessionOption[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  disabled?: boolean;
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onRenameSession,
  disabled,
}: SessionSidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [collapsed, setCollapsed] = useState(false);

  const handleStartRename = useCallback((sessionId: string, currentLabel: string) => {
    setEditingId(sessionId);
    setEditTitle(currentLabel);
  }, []);

  const handleFinishRename = useCallback(() => {
    if (editingId && editTitle.trim()) {
      onRenameSession(editingId, editTitle.trim());
    }
    setEditingId(null);
    setEditTitle('');
  }, [editingId, editTitle, onRenameSession]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleFinishRename();
    } else if (e.key === 'Escape') {
      setEditingId(null);
      setEditTitle('');
    }
  }, [handleFinishRename]);

  if (collapsed) {
    return (
      <aside className="session-sidebar session-sidebar--collapsed">
        <button
          className="session-sidebar__toggle"
          onClick={() => setCollapsed(false)}
          title="Expand session list"
          aria-label="Expand session list"
        >
          ▶
        </button>
      </aside>
    );
  }

  return (
    <aside className="session-sidebar">
      <div className="session-sidebar__header">
        <button
          className="session-sidebar__toggle"
          onClick={() => setCollapsed(true)}
          title="Collapse session list"
          aria-label="Collapse session list"
        >
          ◀
        </button>
        <span className="session-sidebar__title">Sessions</span>
        <button
          className="session-sidebar__new-btn"
          onClick={onNewSession}
          disabled={disabled}
          title="New chat session"
          aria-label="New chat session"
        >
          +
        </button>
      </div>
      <ul className="session-sidebar__list">
        {sessions.map((session) => {
          const isActive = session.sessionId === activeSessionId;
          const isEditing = editingId === session.sessionId;
          const isWebSession = session.channelType === 'web';
          const channelIcon = session.channelType === 'discord'
            ? '💬'
            : session.channelType === 'terminal'
              ? '🖥️'
              : '🌐';

          return (
            <li
              key={session.sessionId}
              className={`session-sidebar__item ${isActive ? 'session-sidebar__item--active' : ''}`}
            >
              <button
                className="session-sidebar__item-btn"
                onClick={() => onSelectSession(session.sessionId)}
                disabled={disabled}
                title={session.label}
              >
                <span className="session-sidebar__item-icon">{channelIcon}</span>
                {isEditing ? (
                  <input
                    className="session-sidebar__rename-input"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onBlur={handleFinishRename}
                    onKeyDown={handleKeyDown}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="session-sidebar__item-label">{session.label}</span>
                )}
                {session.readOnly && (
                  <span className="session-sidebar__readonly-badge">RO</span>
                )}
              </button>
              {isWebSession && !isEditing && (
                <div className="session-sidebar__item-actions">
                  <button
                    className="session-sidebar__action-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleStartRename(session.sessionId, session.label);
                    }}
                    disabled={disabled}
                    title="Rename session"
                    aria-label="Rename session"
                  >
                    ✏️
                  </button>
                  <button
                    className="session-sidebar__action-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteSession(session.sessionId);
                    }}
                    disabled={disabled}
                    title="Delete session"
                    aria-label="Delete session"
                  >
                    🗑️
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
