import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { GitService } from '../GitService.js';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'keygate-git-service-test-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, shell: false, timeout: 15000 });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(stderr || `git exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

describe('GitService', () => {
  it('reports status for unborn repositories without throwing', async () => {
    await withTempDir(async (dir) => {
      await runGit(['init', '-b', 'main'], dir);
      await writeFile(path.join(dir, 'notes.txt'), 'hello\n', 'utf8');

      const git = new GitService();
      const state = await git.getStatus(dir);

      expect(state.isRepo).toBe(true);
      expect(state.branch).toBe('main');
      expect(state.ahead).toBe(0);
      expect(state.behind).toBe(0);
      expect(state.untracked).toEqual(['notes.txt']);
      expect(state.staged).toEqual([]);
      expect(state.unstaged).toEqual([]);
    });
  });

  it('returns an empty log for unborn repositories', async () => {
    await withTempDir(async (dir) => {
      await runGit(['init', '-b', 'main'], dir);

      const git = new GitService();
      await expect(git.getLog(dir)).resolves.toEqual([]);
    });
  });

  it('still reports a branch token for detached HEAD repositories', async () => {
    await withTempDir(async (dir) => {
      await runGit(['init', '-b', 'main'], dir);
      await runGit(['config', 'user.name', 'tester'], dir);
      await runGit(['config', 'user.email', 'tester@example.com'], dir);
      await writeFile(path.join(dir, 'notes.txt'), 'hello\n', 'utf8');
      await runGit(['add', '--', 'notes.txt'], dir);
      await runGit(['commit', '-m', 'init'], dir);
      await runGit(['checkout', '--detach'], dir);

      const git = new GitService();
      const state = await git.getStatus(dir);

      expect(state.isRepo).toBe(true);
      expect(state.branch).toBe('HEAD');
    });
  });
});
