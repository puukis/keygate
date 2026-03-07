import { useState, useCallback } from 'react';
import { DiffView, type FileDiffView } from './DiffView';
import './GitPanel.css';

export interface GitFileChange {
  path: string;
  status: string;
  oldPath?: string;
}

export interface GitRepoStateView {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: string[];
}

export interface GitCommitView {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

interface GitPanelProps {
  connected: boolean;
  state: GitRepoStateView | null;
  diff: FileDiffView[];
  stagedDiff: FileDiffView[];
  log: GitCommitView[];
  onRefresh: () => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onDiscard: (path: string) => void;
  onCommit: (message: string) => void;
  onFetchDiff: () => void;
  onFetchStagedDiff: () => void;
  onFetchLog: () => void;
}

type GitTab = 'changes' | 'history';

export function GitPanel({
  connected,
  state,
  diff,
  stagedDiff,
  log,
  onRefresh,
  onStage,
  onUnstage,
  onDiscard,
  onCommit,
  onFetchDiff,
  onFetchStagedDiff,
  onFetchLog,
}: GitPanelProps) {
  const [activeTab, setActiveTab] = useState<GitTab>('changes');
  const [commitMsg, setCommitMsg] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [showStagedDiff, setShowStagedDiff] = useState(false);
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);

  const handleCommit = useCallback(() => {
    if (!commitMsg.trim()) return;
    onCommit(commitMsg.trim());
    setCommitMsg('');
  }, [commitMsg, onCommit]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleCommit();
    }
  }, [handleCommit]);

  const toggleDiff = useCallback(() => {
    if (!showDiff) onFetchDiff();
    setShowDiff((v) => !v);
  }, [showDiff, onFetchDiff]);

  const toggleStagedDiff = useCallback(() => {
    if (!showStagedDiff) onFetchStagedDiff();
    setShowStagedDiff((v) => !v);
  }, [showStagedDiff, onFetchStagedDiff]);

  const handleTabHistory = useCallback(() => {
    setActiveTab('history');
    onFetchLog();
  }, [onFetchLog]);

  if (!connected) {
    return <div className="git-panel-empty">Not connected</div>;
  }

  if (!state) {
    return (
      <div className="git-panel-empty">
        <button className="git-btn" onClick={onRefresh}>Load Git Status</button>
      </div>
    );
  }

  if (!state.isRepo) {
    return (
      <div className="git-panel-empty">
        <div className="git-panel-empty-icon">⊘</div>
        <div>Not a git repository</div>
      </div>
    );
  }

  const totalChanges = state.staged.length + state.unstaged.length + state.untracked.length;

  return (
    <div className="git-panel">
      {/* Header */}
      <div className="git-header">
        <div className="git-branch">
          <span className="git-branch-icon">⎇</span>
          <span className="git-branch-name">{state.branch}</span>
          {(state.ahead > 0 || state.behind > 0) && (
            <span className="git-ahead-behind">
              {state.ahead > 0 && <span className="git-ahead">↑{state.ahead}</span>}
              {state.behind > 0 && <span className="git-behind">↓{state.behind}</span>}
            </span>
          )}
        </div>
        <button className="git-btn git-btn-icon" onClick={onRefresh} title="Refresh">↻</button>
      </div>

      {/* Tabs */}
      <div className="git-tabs">
        <button
          className={`git-tab ${activeTab === 'changes' ? 'git-tab-active' : ''}`}
          onClick={() => setActiveTab('changes')}
        >
          Changes {totalChanges > 0 && <span className="git-badge">{totalChanges}</span>}
        </button>
        <button
          className={`git-tab ${activeTab === 'history' ? 'git-tab-active' : ''}`}
          onClick={handleTabHistory}
        >
          History
        </button>
      </div>

      {/* Changes tab */}
      {activeTab === 'changes' && (
        <div className="git-changes">
          {/* Staged */}
          {state.staged.length > 0 && (
            <div className="git-section">
              <div className="git-section-header">
                <span>Staged ({state.staged.length})</span>
                <button className="git-btn-sm" onClick={toggleStagedDiff}>
                  {showStagedDiff ? 'Hide diff' : 'Show diff'}
                </button>
              </div>
              {state.staged.map((f, i) => (
                <div key={i} className="git-file-row">
                  <span className={`git-file-status git-file-status-${f.status}`}>
                    {f.status[0]?.toUpperCase()}
                  </span>
                  <span className="git-file-path" title={f.path}>{f.path}</span>
                  <button className="git-btn-sm" onClick={() => onUnstage(f.path)} title="Unstage">−</button>
                </div>
              ))}
              {showStagedDiff && stagedDiff.length > 0 && (
                <div className="git-inline-diff">
                  <DiffView diffs={stagedDiff} />
                </div>
              )}
            </div>
          )}

          {/* Unstaged */}
          {state.unstaged.length > 0 && (
            <div className="git-section">
              <div className="git-section-header">
                <span>Unstaged ({state.unstaged.length})</span>
                <button className="git-btn-sm" onClick={toggleDiff}>
                  {showDiff ? 'Hide diff' : 'Show diff'}
                </button>
              </div>
              {state.unstaged.map((f, i) => (
                <div key={i} className="git-file-row">
                  <span className={`git-file-status git-file-status-${f.status}`}>
                    {f.status[0]?.toUpperCase()}
                  </span>
                  <span className="git-file-path" title={f.path}>{f.path}</span>
                  <div className="git-file-actions">
                    <button className="git-btn-sm" onClick={() => onStage(f.path)} title="Stage">+</button>
                    <button className="git-btn-sm git-btn-danger" onClick={() => onDiscard(f.path)} title="Discard">✕</button>
                  </div>
                </div>
              ))}
              {showDiff && diff.length > 0 && (
                <div className="git-inline-diff">
                  <DiffView diffs={diff} />
                </div>
              )}
            </div>
          )}

          {/* Untracked */}
          {state.untracked.length > 0 && (
            <div className="git-section">
              <div className="git-section-header">
                <span>Untracked ({state.untracked.length})</span>
              </div>
              {state.untracked.map((f, i) => (
                <div key={i} className="git-file-row">
                  <span className="git-file-status git-file-status-added">?</span>
                  <span className="git-file-path" title={f}>{f}</span>
                  <button className="git-btn-sm" onClick={() => onStage(f)} title="Stage">+</button>
                </div>
              ))}
            </div>
          )}

          {totalChanges === 0 && (
            <div className="git-no-changes">Working tree clean</div>
          )}

          {/* Commit box */}
          {state.staged.length > 0 && (
            <div className="git-commit-box">
              <input
                className="git-commit-input"
                type="text"
                placeholder="Commit message…"
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                onKeyDown={handleKeyDown}
              />
              <button className="git-btn git-btn-primary" onClick={handleCommit} disabled={!commitMsg.trim()}>
                Commit
              </button>
            </div>
          )}
        </div>
      )}

      {/* History tab */}
      {activeTab === 'history' && (
        <div className="git-history">
          {log.length === 0 ? (
            <div className="git-no-changes">No commits</div>
          ) : (
            log.map((c) => (
              <div
                key={c.hash}
                className={`git-commit-row ${expandedCommit === c.hash ? 'git-commit-expanded' : ''}`}
                onClick={() => setExpandedCommit(expandedCommit === c.hash ? null : c.hash)}
              >
                <div className="git-commit-main">
                  <span className="git-commit-hash">{c.shortHash}</span>
                  <span className="git-commit-message">{c.message}</span>
                </div>
                {expandedCommit === c.hash && (
                  <div className="git-commit-details">
                    <div><strong>Author:</strong> {c.author}</div>
                    <div><strong>Date:</strong> {new Date(c.date).toLocaleString()}</div>
                    <div><strong>Hash:</strong> {c.hash}</div>
                    {c.filesChanged > 0 && (
                      <div className="git-commit-stats">
                        {c.filesChanged} file{c.filesChanged !== 1 ? 's' : ''}
                        {c.insertions > 0 && <span className="git-stat-add"> +{c.insertions}</span>}
                        {c.deletions > 0 && <span className="git-stat-del"> -{c.deletions}</span>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
