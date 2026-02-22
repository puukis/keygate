import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { SkillsManager } from './manager.js';

export async function installSkillsFromSource(
  manager: SkillsManager,
  options: {
    source: string;
    scope: 'workspace' | 'global';
    targetName: string;
    installAll: boolean;
  }
): Promise<string[]> {
  const sourceResolution = await resolveSourceDirectory(options.source);
  try {
    const discovered = await discoverSkillDirs(sourceResolution.path);

    let selected = discovered;
    if (options.targetName.length > 0) {
      selected = selected.filter((entry) => path.basename(entry) === options.targetName);
    } else if (!options.installAll && discovered.length > 1) {
      throw new Error('Source contains multiple skills. Use --name <skill> or --all.');
    }

    const targetRoot = manager.getScopeRoot(options.scope);
    await fs.mkdir(targetRoot, { recursive: true });

    const installed: string[] = [];

    for (const skillDir of selected) {
      const name = path.basename(skillDir);
      const targetDir = path.join(targetRoot, name);

      await fs.rm(targetDir, { recursive: true, force: true });
      await fs.cp(skillDir, targetDir, { recursive: true });
      installed.push(name);
    }

    if (installed.length > 0) {
      const state = await manager.loadInstallState(options.scope);
      const now = new Date().toISOString();

      for (const name of installed) {
        state.records[name] = {
          name,
          source: options.source,
          scope: options.scope,
          installedAt: now,
        };
      }

      await manager.saveInstallState(options.scope, state);
      await manager.refresh();
    }

    return installed;
  } finally {
    if (sourceResolution.cleanup) {
      await sourceResolution.cleanup();
    }
  }
}

export async function resolveSourceDirectory(source: string): Promise<{ path: string; cleanup?: () => Promise<void> }> {
  const expanded = expandHome(source);
  const resolved = path.resolve(expanded);

  if (await pathExists(resolved)) {
    return { path: resolved };
  }

  if (!looksLikeGitSource(source)) {
    throw new Error(`Source path does not exist: ${source}`);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-skill-install-'));
  const cloneResult = spawnSync('git', ['clone', '--depth', '1', source, tempDir], {
    encoding: 'utf8',
  });

  if (cloneResult.status !== 0) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw new Error(`git clone failed: ${(cloneResult.stderr || cloneResult.stdout || '').trim()}`);
  }

  return {
    path: tempDir,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

export async function discoverSkillDirs(root: string): Promise<string[]> {
  const result: string[] = [];
  const rootSkillFile = path.join(root, 'SKILL.md');
  if (await pathExists(rootSkillFile)) {
    result.push(root);
  }

  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillDir = path.join(root, entry.name);
    if (await pathExists(path.join(skillDir, 'SKILL.md'))) {
      result.push(skillDir);
    }
  }

  return Array.from(new Set(result));
}

export function normalizeScope(value: string): 'workspace' | 'global' {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'global') {
    return 'global';
  }

  if (normalized === 'workspace') {
    return 'workspace';
  }

  throw new Error(`Invalid scope "${value}". Expected workspace or global.`);
}

export function looksLikeGitSource(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://') || value.startsWith('git@') || value.endsWith('.git');
}

export function expandHome(value: string): string {
  if (value === '~') {
    return os.homedir();
  }

  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
