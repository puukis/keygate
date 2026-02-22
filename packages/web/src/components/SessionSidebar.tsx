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
  onOpenSettings?: () => void;
  disabled?: boolean;
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onRenameSession,
  onOpenSettings,
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
      {onOpenSettings && (
        <div className="session-sidebar__footer">
          <button
            className="session-sidebar__settings-btn"
            onClick={onOpenSettings}
            title="Settings"
            aria-label="Settings"
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M8.325 2.317a1 1 0 0 1 .98-.804h1.39a1 1 0 0 1 .98.804l.232 1.16a5.98 5.98 0 0 1 1.308.754l1.116-.372a1 1 0 0 1 1.177.481l.694 1.202a1 1 0 0 1-.196 1.284l-.884.788a6.1 6.1 0 0 1 0 1.512l.884.788a1 1 0 0 1 .196 1.284l-.694 1.202a1 1 0 0 1-1.177.481l-1.116-.372a5.98 5.98 0 0 1-1.308.754l-.231 1.16a1 1 0 0 1-.981.804H9.305a1 1 0 0 1-.98-.804l-.232-1.16a5.98 5.98 0 0 1-1.308-.754l-1.116.372a1 1 0 0 1-1.177-.481l-.694-1.202a1 1 0 0 1 .196-1.284l.884-.788a6.1 6.1 0 0 1 0-1.512l-.884-.788a1 1 0 0 1-.196-1.284l.694-1.202a1 1 0 0 1 1.177-.481l1.116.372a5.98 5.98 0 0 1 1.308-.754l.231-1.16ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" fill="currentColor" />
            </svg>
            <span>Settings</span>
          </button>
        </div>
      )}
    </aside>
  );
}
