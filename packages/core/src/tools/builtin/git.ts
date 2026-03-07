import type { Tool, ToolResult } from '../../types.js';
import { GitService } from '../../git/index.js';

const git = new GitService();

function resolveCwd(args: Record<string, unknown>): string {
  return (args['cwd'] as string | undefined) ?? process.cwd();
}

const gitStatusTool: Tool = {
  name: 'git_status',
  description:
    'Get the current git repository status including branch, staged/unstaged/untracked files, and ahead/behind counts.',
  parameters: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: 'Working directory (defaults to workspace)' },
    },
    required: [],
  },
  requiresConfirmation: false,
  type: 'other',
  handler: async (args): Promise<ToolResult> => {
    try {
      const state = await git.getStatus(resolveCwd(args));
      if (!state.isRepo) {
        return { success: true, output: 'Not a git repository.' };
      }
      return { success: true, output: JSON.stringify(state, null, 2) };
    } catch (error) {
      return { success: false, output: '', error: error instanceof Error ? error.message : 'git_status failed' };
    }
  },
};

const gitDiffTool: Tool = {
  name: 'git_diff',
  description:
    'Get the unified diff of unstaged changes in the git repository. Returns structured diff with per-file hunks.',
  parameters: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: 'Working directory (defaults to workspace)' },
      staged: { type: 'boolean', description: 'If true, show staged (cached) diff instead of unstaged' },
      file: { type: 'string', description: 'If provided, show diff for this specific file only' },
    },
    required: [],
  },
  requiresConfirmation: false,
  type: 'other',
  handler: async (args): Promise<ToolResult> => {
    try {
      const cwd = resolveCwd(args);
      const staged = args['staged'] === true;
      const file = args['file'] as string | undefined;

      let diffs;
      if (file) {
        const d = await git.getFileDiff(cwd, file);
        diffs = d ? [d] : [];
      } else if (staged) {
        diffs = await git.getStagedDiff(cwd);
      } else {
        diffs = await git.getDiff(cwd);
      }

      if (diffs.length === 0) {
        return { success: true, output: 'No differences found.' };
      }
      return { success: true, output: JSON.stringify(diffs, null, 2) };
    } catch (error) {
      return { success: false, output: '', error: error instanceof Error ? error.message : 'git_diff failed' };
    }
  },
};

const gitLogTool: Tool = {
  name: 'git_log',
  description:
    'Get recent git commit history with author, date, message, and change statistics.',
  parameters: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: 'Working directory (defaults to workspace)' },
      limit: { type: 'number', description: 'Maximum number of commits to return (default: 20)' },
    },
    required: [],
  },
  requiresConfirmation: false,
  type: 'other',
  handler: async (args): Promise<ToolResult> => {
    try {
      const cwd = resolveCwd(args);
      const limit = typeof args['limit'] === 'number' ? args['limit'] : 20;
      const commits = await git.getLog(cwd, limit);
      if (commits.length === 0) {
        return { success: true, output: 'No commits found.' };
      }
      return { success: true, output: JSON.stringify(commits, null, 2) };
    } catch (error) {
      return { success: false, output: '', error: error instanceof Error ? error.message : 'git_log failed' };
    }
  },
};

const gitCommitTool: Tool = {
  name: 'git_commit',
  description:
    'Commit all currently staged changes with the given message. Use git_status first to verify what is staged.',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The commit message' },
      cwd: { type: 'string', description: 'Working directory (defaults to workspace)' },
    },
    required: ['message'],
  },
  requiresConfirmation: true,
  type: 'other',
  handler: async (args): Promise<ToolResult> => {
    try {
      const cwd = resolveCwd(args);
      const message = args['message'] as string;
      if (!message.trim()) {
        return { success: false, output: '', error: 'Commit message cannot be empty.' };
      }
      const result = await git.commit(cwd, message);
      return { success: true, output: result };
    } catch (error) {
      return { success: false, output: '', error: error instanceof Error ? error.message : 'git_commit failed' };
    }
  },
};

export const gitTools: Tool[] = [gitStatusTool, gitDiffTool, gitLogTool, gitCommitTool];
