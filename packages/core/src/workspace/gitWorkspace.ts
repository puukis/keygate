import { spawn } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { resolveWorkspacePath } from './agentWorkspace.js';

const DEFAULT_BRANCH = 'main';
const DEFAULT_COMMIT_MESSAGE = 'Initialize Keygate workspace';
const DEFAULT_LOCAL_GIT_NAME = 'Keygate Local';
const DEFAULT_LOCAL_GIT_EMAIL = 'keygate@local';
const GITIGNORE_START = '# >>> Keygate managed ignores >>>';
const GITIGNORE_END = '# <<< Keygate managed ignores <<<';

const workspaceRepoInitializers = new Map<string, Promise<WorkspaceGitBootstrapResult>>();

export interface EnsureWorkspaceGitRepoOptions {
  isRootWorkspace?: boolean;
  initialCommitPaths?: string[];
}

export interface WorkspaceGitBootstrapResult {
  workspacePath: string;
  createdRepo: boolean;
  configuredIdentity: boolean;
  updatedGitignore: boolean;
  createdInitialCommit: boolean;
  branch: string;
}

export async function ensureWorkspaceGitRepo(
  workspacePath: string,
  options: EnsureWorkspaceGitRepoOptions = {},
): Promise<WorkspaceGitBootstrapResult> {
  const resolvedWorkspace = resolveWorkspacePath(workspacePath);
  const inFlight = workspaceRepoInitializers.get(resolvedWorkspace);
  if (inFlight) {
    return inFlight;
  }

  const pending = ensureWorkspaceGitRepoInternal(resolvedWorkspace, options)
    .finally(() => {
      workspaceRepoInitializers.delete(resolvedWorkspace);
    });
  workspaceRepoInitializers.set(resolvedWorkspace, pending);
  return pending;
}

async function ensureWorkspaceGitRepoInternal(
  workspacePath: string,
  options: EnsureWorkspaceGitRepoOptions,
): Promise<WorkspaceGitBootstrapResult> {
  await fs.mkdir(workspacePath, { recursive: true });

  const gitDir = path.join(workspacePath, '.git');
  const createdRepo = !(await pathExists(gitDir));
  if (createdRepo) {
    await initializeGitRepo(workspacePath);
  }

  const configuredIdentity = createdRepo
    ? await ensureRepoLocalIdentity(workspacePath)
    : false;
  const updatedGitignore = await ensureManagedGitignore(workspacePath, options.isRootWorkspace === true);

  let createdInitialCommit = false;
  if (createdRepo) {
    const stageTargets = new Set<string>();
    if (updatedGitignore) {
      stageTargets.add('.gitignore');
    }

    for (const target of normalizeInitialCommitPaths(options.initialCommitPaths)) {
      if (await pathExists(path.join(workspacePath, target))) {
        stageTargets.add(target);
      }
    }

    if (stageTargets.size > 0) {
      await runGit(['add', '--', ...Array.from(stageTargets)], workspacePath);
      await runGit(['commit', '-m', DEFAULT_COMMIT_MESSAGE], workspacePath);
    } else {
      await runGit(['commit', '--allow-empty', '-m', DEFAULT_COMMIT_MESSAGE], workspacePath);
    }
    createdInitialCommit = true;
  }

  return {
    workspacePath,
    createdRepo,
    configuredIdentity,
    updatedGitignore,
    createdInitialCommit,
    branch: await getBranchName(workspacePath),
  };
}

async function initializeGitRepo(workspacePath: string): Promise<void> {
  try {
    await runGit(['init', '-b', DEFAULT_BRANCH], workspacePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!supportsBranchFlag(message)) {
      throw error;
    }

    await runGit(['init'], workspacePath);
    await runGit(['symbolic-ref', 'HEAD', `refs/heads/${DEFAULT_BRANCH}`], workspacePath);
  }
}

function supportsBranchFlag(message: string): boolean {
  return /unknown switch [`']?b|unknown option [`']?b|usage: git init/i.test(message);
}

async function ensureRepoLocalIdentity(workspacePath: string): Promise<boolean> {
  const currentName = await getOptionalGitConfig(workspacePath, 'user.name');
  const currentEmail = await getOptionalGitConfig(workspacePath, 'user.email');

  let changed = false;
  if (!currentName) {
    await runGit(['config', '--local', 'user.name', DEFAULT_LOCAL_GIT_NAME], workspacePath);
    changed = true;
  }
  if (!currentEmail) {
    await runGit(['config', '--local', 'user.email', DEFAULT_LOCAL_GIT_EMAIL], workspacePath);
    changed = true;
  }

  return changed;
}

async function getOptionalGitConfig(workspacePath: string, key: string): Promise<string> {
  try {
    return (await runGit(['config', '--local', '--get', key], workspacePath)).trim();
  } catch {
    return '';
  }
}

async function ensureManagedGitignore(workspacePath: string, isRootWorkspace: boolean): Promise<boolean> {
  const targetPath = path.join(workspacePath, '.gitignore');
  const managedEntries = [
    '.keygate-browser-runs/',
    '.keygate-uploads/',
    ...(isRootWorkspace ? ['agents/'] : []),
  ];
  const managedBlock = `${GITIGNORE_START}\n${managedEntries.join('\n')}\n${GITIGNORE_END}`;

  let current = '';
  try {
    current = await fs.readFile(targetPath, 'utf8');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  const normalizedCurrent = current.replace(/\r\n/g, '\n');
  const startIndex = normalizedCurrent.indexOf(GITIGNORE_START);
  const endIndex = normalizedCurrent.indexOf(GITIGNORE_END);

  let next: string;
  if (startIndex >= 0 && endIndex > startIndex) {
    const afterEnd = endIndex + GITIGNORE_END.length;
    next = `${normalizedCurrent.slice(0, startIndex)}${managedBlock}${normalizedCurrent.slice(afterEnd)}`;
  } else if (normalizedCurrent.trim().length === 0) {
    next = `${managedBlock}\n`;
  } else {
    const separator = normalizedCurrent.endsWith('\n') ? '\n' : '\n\n';
    next = `${normalizedCurrent}${separator}${managedBlock}\n`;
  }

  if (normalizeText(next) === normalizeText(normalizedCurrent)) {
    return false;
  }

  await fs.writeFile(targetPath, next, 'utf8');
  return true;
}

async function getBranchName(workspacePath: string): Promise<string> {
  try {
    return (await runGit(['symbolic-ref', '--short', 'HEAD'], workspacePath)).trim();
  } catch {
    return DEFAULT_BRANCH;
  }
}

function normalizeInitialCommitPaths(paths: string[] | undefined): string[] {
  if (!Array.isArray(paths)) {
    return [];
  }

  return Array.from(new Set(
    paths
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.replace(/\\/g, '/'))
      .filter((entry) => !path.isAbsolute(entry) && !entry.startsWith('../') && !entry.includes('/../')),
  )).sort((left, right) => left.localeCompare(right));
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').trimEnd();
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
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
