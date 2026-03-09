import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ensureWorkspaceGitRepo } from '../gitWorkspace.js';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'keygate-git-workspace-test-'));
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

describe('workspace git bootstrap', () => {
  it('bootstraps a fresh local repo with local identity and one initial commit', async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, 'SOUL.md'), '# SOUL\n', 'utf8');

      const result = await ensureWorkspaceGitRepo(dir, {
        isRootWorkspace: true,
        initialCommitPaths: ['SOUL.md'],
      });

      expect(result.createdRepo).toBe(true);
      expect(result.configuredIdentity).toBe(true);
      expect(result.updatedGitignore).toBe(true);
      expect(result.createdInitialCommit).toBe(true);
      expect(result.branch).toBe('main');

      const gitignore = await readFile(path.join(dir, '.gitignore'), 'utf8');
      expect(gitignore).toContain('.keygate-browser-runs/');
      expect(gitignore).toContain('.keygate-uploads/');
      expect(gitignore).toContain('agents/');

      await expect(runGit(['remote'], dir)).resolves.toBe('');
      await expect(runGit(['config', '--local', '--get', 'user.name'], dir)).resolves.toBe('Keygate Local\n');
      await expect(runGit(['config', '--local', '--get', 'user.email'], dir)).resolves.toBe('keygate@local\n');
      await expect(runGit(['symbolic-ref', '--short', 'HEAD'], dir)).resolves.toBe('main\n');
      await expect(runGit(['rev-list', '--count', 'HEAD'], dir)).resolves.toBe('1\n');

      const committedFiles = (await runGit(['show', '--pretty=', '--name-only', 'HEAD'], dir))
        .split('\n')
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));
      expect(committedFiles).toEqual(['.gitignore', 'SOUL.md']);
    });
  });

  it('does not auto-commit pre-existing user files in a custom workspace', async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, 'notes.txt'), 'do not commit me\n', 'utf8');

      const result = await ensureWorkspaceGitRepo(dir);

      expect(result.createdRepo).toBe(true);
      await expect(runGit(['rev-list', '--count', 'HEAD'], dir)).resolves.toBe('1\n');

      const committedFiles = (await runGit(['show', '--pretty=', '--name-only', 'HEAD'], dir))
        .split('\n')
        .filter(Boolean);
      expect(committedFiles).toEqual(['.gitignore']);

      const status = await runGit(['status', '--porcelain=v1', '-uall'], dir);
      expect(status).toContain('?? notes.txt');
    });
  });

  it('dedupes concurrent initialization and stays idempotent on rerun', async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, 'BOOTSTRAP.md'), '# bootstrap\n', 'utf8');

      const [first, second] = await Promise.all([
        ensureWorkspaceGitRepo(dir, {
          isRootWorkspace: true,
          initialCommitPaths: ['BOOTSTRAP.md'],
        }),
        ensureWorkspaceGitRepo(dir, {
          isRootWorkspace: true,
          initialCommitPaths: ['BOOTSTRAP.md'],
        }),
      ]);

      expect(first.createdRepo).toBe(true);
      expect(second.createdRepo).toBe(true);
      await expect(runGit(['rev-list', '--count', 'HEAD'], dir)).resolves.toBe('1\n');

      const gitignoreBefore = await readFile(path.join(dir, '.gitignore'), 'utf8');
      const rerun = await ensureWorkspaceGitRepo(dir, {
        isRootWorkspace: true,
        initialCommitPaths: ['BOOTSTRAP.md'],
      });
      const gitignoreAfter = await readFile(path.join(dir, '.gitignore'), 'utf8');

      expect(rerun.createdRepo).toBe(false);
      expect(rerun.updatedGitignore).toBe(false);
      expect(rerun.createdInitialCommit).toBe(false);
      expect(gitignoreAfter).toBe(gitignoreBefore);
      await expect(runGit(['rev-list', '--count', 'HEAD'], dir)).resolves.toBe('1\n');
    });
  });
});
