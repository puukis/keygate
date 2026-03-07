import { spawn } from 'node:child_process';
import type {
  FileChange,
  FileChangeStatus,
  FileDiff,
  DiffHunk,
  DiffLine,
  GitCommit,
  GitRepoState,
} from './types.js';

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, shell: false, timeout: 15000 });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `git exited with code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

export class GitService {
  /** Check whether the given path is inside a git repository. */
  async isGitRepo(cwd: string): Promise<boolean> {
    try {
      await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
      return true;
    } catch {
      return false;
    }
  }

  /** Return the current branch name. */
  async getBranch(cwd: string): Promise<string> {
    const out = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    return out.trim();
  }

  /** Return ahead/behind counts relative to upstream. */
  async getAheadBehind(cwd: string): Promise<{ ahead: number; behind: number }> {
    try {
      const out = await runGit(
        ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
        cwd,
      );
      const [behind, ahead] = out.trim().split(/\s+/).map(Number);
      return { ahead: ahead ?? 0, behind: behind ?? 0 };
    } catch {
      // No upstream configured
      return { ahead: 0, behind: 0 };
    }
  }

  /** Parse `git status --porcelain=v1` output. */
  async getStatus(cwd: string): Promise<GitRepoState> {
    const isRepo = await this.isGitRepo(cwd);
    if (!isRepo) {
      return { isRepo: false, branch: '', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] };
    }

    const [branch, { ahead, behind }, porcelain] = await Promise.all([
      this.getBranch(cwd),
      this.getAheadBehind(cwd),
      runGit(['status', '--porcelain=v1', '-uall'], cwd),
    ]);

    const staged: FileChange[] = [];
    const unstaged: FileChange[] = [];
    const untracked: string[] = [];

    for (const line of porcelain.split('\n')) {
      if (!line) continue;
      const x = line[0]; // index status
      const y = line[1]; // worktree status
      const filePath = line.slice(3);

      // Untracked
      if (x === '?' && y === '?') {
        untracked.push(filePath);
        continue;
      }

      // Staged changes (index column)
      if (x && x !== ' ' && x !== '?') {
        staged.push({ path: filePath, status: porcelainCharToStatus(x) });
      }

      // Unstaged changes (worktree column)
      if (y && y !== ' ' && y !== '?') {
        unstaged.push({ path: filePath, status: porcelainCharToStatus(y) });
      }
    }

    return { isRepo: true, branch, ahead, behind, staged, unstaged, untracked };
  }

  /** Return unified diff of unstaged changes. */
  async getDiff(cwd: string): Promise<FileDiff[]> {
    const raw = await runGit(['diff', '--unified=3', '--no-color'], cwd);
    return parseDiff(raw);
  }

  /** Return unified diff of staged changes. */
  async getStagedDiff(cwd: string): Promise<FileDiff[]> {
    const raw = await runGit(['diff', '--cached', '--unified=3', '--no-color'], cwd);
    return parseDiff(raw);
  }

  /** Return diff for a specific file (unstaged). */
  async getFileDiff(cwd: string, filePath: string): Promise<FileDiff | null> {
    const raw = await runGit(['diff', '--unified=3', '--no-color', '--', filePath], cwd);
    const diffs = parseDiff(raw);
    return diffs[0] ?? null;
  }

  /** Return recent commit log. */
  async getLog(cwd: string, limit = 20): Promise<GitCommit[]> {
    const sep = '<<SEP>>';
    const format = ['%H', '%h', '%an', '%aI', '%s'].join(sep);
    const raw = await runGit(
      ['log', `--format=${format}`, '--shortstat', `-${limit}`],
      cwd,
    );
    return parseLog(raw, sep);
  }

  /** Stage a file. */
  async stage(cwd: string, filePath: string): Promise<void> {
    await runGit(['add', '--', filePath], cwd);
  }

  /** Unstage a file. */
  async unstage(cwd: string, filePath: string): Promise<void> {
    await runGit(['reset', 'HEAD', '--', filePath], cwd);
  }

  /** Discard unstaged changes for a file. */
  async discard(cwd: string, filePath: string): Promise<void> {
    await runGit(['checkout', '--', filePath], cwd);
  }

  /** Commit staged changes. */
  async commit(cwd: string, message: string): Promise<string> {
    const out = await runGit(['commit', '-m', message], cwd);
    return out.trim();
  }
}

// ---- Parsing helpers ----

function porcelainCharToStatus(char: string): FileChangeStatus {
  switch (char) {
    case 'A': return 'added';
    case 'M': return 'modified';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    default: return 'modified';
  }
}

function parseDiff(raw: string): FileDiff[] {
  if (!raw.trim()) return [];

  const files: FileDiff[] = [];
  const fileChunks = raw.split(/^diff --git /m).filter(Boolean);

  for (const chunk of fileChunks) {
    const lines = chunk.split('\n');
    // First line: a/path b/path
    const headerMatch = lines[0]?.match(/a\/(.+?)\s+b\/(.+)/);
    if (!headerMatch) continue;

    const oldPath = headerMatch[1];
    const newPath = headerMatch[2];
    const isBinary = chunk.includes('Binary files');

    // Determine status from diff header lines
    let status: FileChangeStatus = 'modified';
    if (chunk.includes('new file mode')) {
      status = 'added';
    } else if (chunk.includes('deleted file mode')) {
      status = 'deleted';
    } else if (chunk.includes('rename from')) {
      status = 'renamed';
    }

    const hunks: DiffHunk[] = [];

    if (!isBinary) {
      const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/;
      let currentHunk: DiffHunk | null = null;

      for (const line of lines) {
        const hunkMatch = line.match(hunkRegex);
        if (hunkMatch) {
          if (currentHunk) hunks.push(currentHunk);
          currentHunk = {
            oldStart: parseInt(hunkMatch[1], 10),
            oldLines: parseInt(hunkMatch[2] ?? '1', 10),
            newStart: parseInt(hunkMatch[3], 10),
            newLines: parseInt(hunkMatch[4] ?? '1', 10),
            header: hunkMatch[5]?.trim() ?? '',
            lines: [],
          };
          continue;
        }

        if (!currentHunk) continue;

        if (line.startsWith('+')) {
          currentHunk.lines.push({ type: 'add', content: line.slice(1) });
        } else if (line.startsWith('-')) {
          currentHunk.lines.push({ type: 'remove', content: line.slice(1) });
        } else if (line.startsWith(' ')) {
          currentHunk.lines.push({ type: 'context', content: line.slice(1) });
        }
      }

      if (currentHunk) hunks.push(currentHunk);
    }

    files.push({
      path: newPath,
      status,
      oldPath: status === 'renamed' ? oldPath : undefined,
      hunks,
      isBinary,
    });
  }

  return files;
}

function parseLog(raw: string, sep: string): GitCommit[] {
  const commits: GitCommit[] = [];
  const lines = raw.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line?.includes(sep)) {
      i++;
      continue;
    }

    const parts = line.split(sep);
    if (parts.length < 5) {
      i++;
      continue;
    }

    const commit: GitCommit = {
      hash: parts[0],
      shortHash: parts[1],
      author: parts[2],
      date: parts[3],
      message: parts[4],
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    };

    // Next non-empty line should be the shortstat
    i++;
    while (i < lines.length && !lines[i]?.trim()) i++;

    if (i < lines.length) {
      const statLine = lines[i]?.trim() ?? '';
      const filesMatch = statLine.match(/(\d+) file/);
      const insMatch = statLine.match(/(\d+) insertion/);
      const delMatch = statLine.match(/(\d+) deletion/);
      if (filesMatch) commit.filesChanged = parseInt(filesMatch[1], 10);
      if (insMatch) commit.insertions = parseInt(insMatch[1], 10);
      if (delMatch) commit.deletions = parseInt(delMatch[1], 10);
    }

    commits.push(commit);
    i++;
  }

  return commits;
}
