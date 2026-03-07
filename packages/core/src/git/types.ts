/** Status of a file change in git */
export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked';

/** A single changed file entry */
export interface FileChange {
  path: string;
  status: FileChangeStatus;
  oldPath?: string;
}

/** A single line within a diff hunk */
export interface DiffLine {
  type: 'context' | 'add' | 'remove';
  content: string;
}

/** A hunk within a file diff */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

/** Full diff for a single file */
export interface FileDiff {
  path: string;
  status: FileChangeStatus;
  oldPath?: string;
  hunks: DiffHunk[];
  isBinary: boolean;
}

/** A git commit entry */
export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** Overall git repository state */
export interface GitRepoState {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: string[];
}

/** Full snapshot sent over WebSocket */
export interface GitSnapshot {
  state: GitRepoState;
  diff: FileDiff[];
  stagedDiff: FileDiff[];
  log: GitCommit[];
}
