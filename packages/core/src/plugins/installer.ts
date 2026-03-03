import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import type { KeygateConfig } from '../types.js';
import { getConfigDir } from '../config/env.js';
import { getPluginManifestFilename, loadPluginManifest } from './manifest.js';
import type {
  PluginInstallRequest,
  PluginInstallResult,
  PluginInstallState,
  PluginScope,
  ResolvedPluginManifest,
} from './types.js';

export type PluginSourceType = 'directory' | 'tarball' | 'git' | 'npm';

const INSTALL_STATE_FILENAME = '.installed.json';

export function classifyPluginSource(source: string): PluginSourceType {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error('Plugin source is required.');
  }

  if (looksLikeDirectory(trimmed)) {
    return 'directory';
  }

  if (looksLikeTarball(trimmed)) {
    return 'tarball';
  }

  if (looksLikeGit(trimmed)) {
    return 'git';
  }

  return 'npm';
}

export async function installPluginFromSource(
  config: KeygateConfig,
  request: PluginInstallRequest
): Promise<PluginInstallResult> {
  const targetRoot = getPluginRoot(config, request.scope);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-plugin-install-'));

  try {
    const sourceType = classifyPluginSource(request.source);
    const stagingRoot = path.join(tempRoot, 'staging');

    if (sourceType === 'directory') {
      const sourceDir = path.resolve(expandHome(request.source));
      if (request.link) {
        const manifest = await loadInstalledManifest(sourceDir, 'explicit', null, 0);
        const targetDir = path.join(targetRoot, manifest.id ?? slugify(manifest.name));
        await fs.mkdir(targetRoot, { recursive: true });
        await fs.rm(targetDir, { recursive: true, force: true });
        await fs.symlink(sourceDir, targetDir, process.platform === 'win32' ? 'junction' : 'dir');
        const linkedManifest = await loadInstalledManifest(targetDir, request.scope, request.scope, 0);
        const record = await upsertInstallRecord(config, request.scope, {
          id: linkedManifest.id ?? slugify(linkedManifest.name),
          source: sourceDir,
          scope: request.scope,
          linked: true,
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          resolvedVersion: linkedManifest.version ?? '0.0.0',
        });
        return {
          manifest: linkedManifest,
          record,
          targetDir,
        };
      }

      await fs.cp(sourceDir, stagingRoot, { recursive: true });
    } else if (sourceType === 'tarball') {
      await fs.mkdir(stagingRoot, { recursive: true });
      runCommand('tar', ['-xzf', path.resolve(expandHome(request.source)), '-C', stagingRoot]);
      await hoistTarballRoot(stagingRoot);
    } else if (sourceType === 'git') {
      runCommand('git', ['clone', '--depth', '1', request.source, stagingRoot]);
    } else {
      await fs.mkdir(stagingRoot, { recursive: true });
      const packedTarball = packNpmSource(request.nodeManager, request.source, tempRoot);
      await fs.mkdir(path.join(tempRoot, 'packed'), { recursive: true });
      runCommand('tar', ['-xzf', packedTarball, '-C', path.join(tempRoot, 'packed')]);
      const packedRoot = path.join(tempRoot, 'packed');
      await hoistTarballRoot(packedRoot);
      await fs.cp(packedRoot, stagingRoot, { recursive: true });
    }

    const manifest = await loadInstalledManifest(stagingRoot, request.scope, request.scope, 0);
    const pluginId = manifest.id ?? slugify(manifest.name);
    const targetDir = path.join(targetRoot, pluginId);

    await fs.mkdir(targetRoot, { recursive: true });
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.cp(stagingRoot, targetDir, { recursive: true });

    if (await pathExists(path.join(targetDir, 'package.json'))) {
      runInstallDependencies(request.nodeManager, targetDir);
    }

    const installedManifest = await loadInstalledManifest(targetDir, request.scope, request.scope, 0);
    const now = new Date().toISOString();
    const record = await upsertInstallRecord(config, request.scope, {
      id: pluginId,
      source: normalizeRecordedSource(request.source),
      scope: request.scope,
      linked: false,
      installedAt: now,
      updatedAt: now,
      resolvedVersion: installedManifest.version ?? '0.0.0',
    });

    return {
      manifest: installedManifest,
      record,
      targetDir,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

export async function updateInstalledPlugin(
  config: KeygateConfig,
  pluginId: string,
  scope?: PluginScope
): Promise<PluginInstallResult> {
  const scopes = scope ? [scope] : (['workspace', 'global'] as const);

  for (const currentScope of scopes) {
    const state = await loadPluginInstallState(config, currentScope);
    const record = state.records[pluginId];
    if (!record) {
      continue;
    }

    const next = await installPluginFromSource(config, {
      source: record.source,
      scope: currentScope,
      link: record.linked,
      nodeManager: config.plugins?.install.nodeManager ?? 'npm',
    });

    const updatedRecord = {
      ...next.record,
      installedAt: record.installedAt,
      updatedAt: new Date().toISOString(),
      linked: record.linked,
      source: record.source,
    };
    await upsertInstallRecord(config, currentScope, updatedRecord);
    return {
      ...next,
      record: updatedRecord,
    };
  }

  throw new Error(`Plugin is not installed: ${pluginId}`);
}

export async function removeInstalledPlugin(
  config: KeygateConfig,
  pluginId: string,
  options: {
    purge?: boolean;
    scope?: PluginScope;
  } = {}
): Promise<boolean> {
  const scopes = options.scope ? [options.scope] : (['workspace', 'global'] as const);

  for (const currentScope of scopes) {
    const state = await loadPluginInstallState(config, currentScope);
    const record = state.records[pluginId];
    if (!record) {
      continue;
    }

    const targetDir = path.join(getPluginRoot(config, currentScope), pluginId);
    await fs.rm(targetDir, { recursive: true, force: true });
    delete state.records[pluginId];
    await savePluginInstallState(config, currentScope, state);
    return true;
  }

  return false;
}

export async function loadPluginInstallState(
  config: KeygateConfig,
  scope: PluginScope
): Promise<PluginInstallState> {
  const statePath = getInstallStatePath(config, scope);
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as PluginInstallState;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.records !== 'object') {
      return { records: {} };
    }
    return parsed;
  } catch {
    return { records: {} };
  }
}

export async function savePluginInstallState(
  config: KeygateConfig,
  scope: PluginScope,
  state: PluginInstallState
): Promise<void> {
  const statePath = getInstallStatePath(config, scope);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function getInstallStatePath(config: KeygateConfig, scope: PluginScope): string {
  return path.join(getPluginRoot(config, scope), INSTALL_STATE_FILENAME);
}

export function getPluginRoot(config: KeygateConfig, scope: PluginScope): string {
  if (scope === 'workspace') {
    return path.resolve(expandHome(config.security.workspacePath), 'plugins');
  }

  return path.join(getConfigDir(), 'plugins');
}

async function upsertInstallRecord(
  config: KeygateConfig,
  scope: PluginScope,
  record: PluginInstallState['records'][string]
): Promise<PluginInstallState['records'][string]> {
  const state = await loadPluginInstallState(config, scope);
  state.records[record.id] = record;
  await savePluginInstallState(config, scope, state);
  return record;
}

function runInstallDependencies(nodeManager: string, cwd: string): void {
  const args = nodeManager === 'bun'
    ? ['install', '--production', '--ignore-scripts']
    : ['install', '--prod', '--ignore-scripts'];

  runCommand(nodeManager, args, cwd);
}

function packNpmSource(nodeManager: string, source: string, cwd: string): string {
  const result = runCommand(nodeManager, ['pack', source], cwd, true);
  const stdout = `${result.stdout ?? ''}`.trim().split(/\r?\n/g).filter(Boolean);
  const fileName = stdout[stdout.length - 1];
  if (!fileName) {
    throw new Error(`Failed to pack plugin source: ${source}`);
  }
  return path.resolve(cwd, fileName);
}

function runCommand(
  command: string,
  args: string[],
  cwd?: string,
  capture = false
): ReturnType<typeof spawnSync> {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'pipe',
  });

  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' && result.stderr.trim().length > 0
      ? result.stderr.trim()
      : `Command failed: ${command} ${args.join(' ')}`;
    throw new Error(stderr);
  }

  return result;
}

async function loadInstalledManifest(
  rootDir: string,
  sourceKind: 'explicit' | 'workspace' | 'global',
  scope: PluginScope | null,
  precedence: number
): Promise<ResolvedPluginManifest> {
  const manifestPath = path.join(rootDir, getPluginManifestFilename());
  if (!(await pathExists(manifestPath))) {
    throw new Error(`Plugin source does not contain ${getPluginManifestFilename()}.`);
  }

  return loadPluginManifest(manifestPath, {
    sourceKind,
    scope,
    precedence,
  });
}

async function hoistTarballRoot(rootDir: string): Promise<void> {
  const packageDir = path.join(rootDir, 'package');
  if (!(await pathExists(packageDir))) {
    return;
  }

  const tempDir = path.join(path.dirname(rootDir), `hoist-${Date.now()}`);
  await fs.rename(packageDir, tempDir);
  const entries = await fs.readdir(rootDir);
  for (const entry of entries) {
    await fs.rm(path.join(rootDir, entry), { recursive: true, force: true });
  }
  const movedEntries = await fs.readdir(tempDir);
  for (const entry of movedEntries) {
    await fs.rename(path.join(tempDir, entry), path.join(rootDir, entry));
  }
  await fs.rm(tempDir, { recursive: true, force: true });
}

function looksLikeDirectory(source: string): boolean {
  try {
    const target = path.resolve(expandHome(source));
    return existsSync(target) && statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function looksLikeTarball(source: string): boolean {
  const normalized = source.trim();
  if (!/\.tgz$/i.test(normalized)) {
    return false;
  }

  try {
    const target = path.resolve(expandHome(normalized));
    return existsSync(target) && statSync(target).isFile();
  } catch {
    return false;
  }
}

function looksLikeGit(source: string): boolean {
  const normalized = source.trim();
  return normalized.startsWith('git@')
    || normalized.startsWith('git+')
    || normalized.startsWith('ssh://')
    || normalized.endsWith('.git')
    || /^https?:\/\/.+\.git(?:#.*)?$/i.test(normalized);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function expandHome(inputPath: string): string {
  if (inputPath === '~') {
    return process.env['HOME'] ?? inputPath;
  }

  if (inputPath.startsWith('~/')) {
    return path.join(process.env['HOME'] ?? '', inputPath.slice(2));
  }

  return inputPath;
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/g, '')
    .replace(/-+$/g, '');

  return normalized || 'plugin';
}

function normalizeRecordedSource(source: string): string {
  if (looksLikeDirectory(source) || looksLikeTarball(source)) {
    return path.resolve(expandHome(source));
  }

  return source.trim();
}
