import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { hasFlag, type ParsedArgs } from '../argv.js';
import { loadConfigFromEnv } from '../../config/env.js';
import { MCPBrowserManager } from '../../codex/mcpBrowserManager.js';

interface NpmInstallInfo {
  packageName: string;
  version: string;
}

interface NpmPackageManifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

type InstallMode = 'npm' | 'github' | 'unknown';

export async function runUpdateCommand(args: ParsedArgs): Promise<void> {
  const checkOnly = hasFlag(args.flags, 'check-only');
  const npmPackageOverride = process.env['KEYGATE_NPM_PACKAGE']?.trim();
  const packageCandidates = uniqueStrings([npmPackageOverride || '@puukis/cli', '@keygate/cli', 'keygate']);

  const runtimeEntry = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
  const repoRoot = detectRepoRoot(runtimeEntry);
  const npmInstall = detectNpmInstall(packageCandidates);
  const mode = resolveInstallMode(repoRoot, npmInstall);

  console.log('Keygate update');
  console.log(`- mode detected: ${mode}`);

  if (mode === 'npm') {
    if (!npmInstall) {
      throw new Error('Detected npm install mode but could not resolve installed package.');
    }
    updateNpmInstall(npmInstall, checkOnly);
    if (!checkOnly) {
      await reapplyMcpBrowserConfig();
    }
    return;
  }

  if (mode === 'github') {
    if (!repoRoot) {
      throw new Error('Detected github install mode but could not resolve repository path.');
    }
    updateGithubInstall(repoRoot, checkOnly);
    if (!checkOnly) {
      await reapplyMcpBrowserConfig();
    }
    return;
  }

  throw new Error(
    'Could not determine installation mode. If installed via npm, reinstall with npm. ' +
      'If installed via source, run the latest install script to restore launcher metadata.'
  );
}

async function reapplyMcpBrowserConfig(): Promise<void> {
  try {
    const config = loadConfigFromEnv();
    const manager = new MCPBrowserManager(config);
    const currentStatus = await manager.status();

    if (!currentStatus.installed) {
      return;
    }

    const refreshedStatus = await manager.update();
    console.log('Re-applied MCP browser config after update.');
    console.log('- playwright version: ' + refreshedStatus.desiredVersion);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('Warning: failed to re-apply MCP browser config after update: ' + message);
  }
}

function resolveInstallMode(repoRoot: string | undefined, npmInstall: NpmInstallInfo | undefined): InstallMode {
  if (repoRoot) {
    return 'github';
  }

  if (npmInstall) {
    return 'npm';
  }

  return 'unknown';
}

function detectRepoRoot(runtimeEntry: string | undefined): string | undefined {
  if (!runtimeEntry) {
    return undefined;
  }

  let current = path.dirname(runtimeEntry);
  while (true) {
    const packageJsonPath = path.join(current, 'package.json');
    const gitDirPath = path.join(current, '.git');

    if (fs.existsSync(packageJsonPath) && fs.existsSync(gitDirPath)) {
      const pkg = readJsonFile<{ name?: string }>(packageJsonPath);
      if (pkg?.name === 'keygate') {
        return current;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function detectNpmInstall(packageCandidates: string[]): NpmInstallInfo | undefined {
  if (!isCommandAvailable('npm')) {
    return undefined;
  }

  for (const packageName of packageCandidates) {
    const result = spawnSync('npm', ['list', '-g', '--depth=0', '--json', packageName], {
      encoding: 'utf8',
    });

    if (result.status !== 0 && result.stdout.trim().length === 0) {
      continue;
    }

    const parsed = tryParseJson<{
      dependencies?: Record<string, { version?: string }>;
    }>(result.stdout);

    const version = parsed?.dependencies?.[packageName]?.version;
    if (version) {
      return { packageName, version };
    }
  }

  return undefined;
}

function updateNpmInstall(info: NpmInstallInfo, checkOnly: boolean): void {
  const latest = getNpmLatestVersion(info.packageName);
  const current = info.version;

  console.log(`- npm package: ${info.packageName}`);
  console.log(`- installed version: ${current}`);
  if (latest) {
    console.log(`- latest npm version: ${latest}`);
  }

  if (!latest) {
    if (checkOnly) {
      console.log('Could not resolve latest npm version.');
      return;
    }
    console.log('Latest version lookup failed; attempting update anyway...');
  } else {
    const comparison = compareVersions(current, latest);
    if (comparison >= 0) {
      console.log('Already up to date.');
      return;
    }

    if (checkOnly) {
      console.log('Update available.');
      return;
    }
  }

  const update = spawnSync('npm', ['install', '-g', `${info.packageName}@latest`], {
    encoding: 'utf8',
  });

  if (update.stdout) {
    process.stdout.write(update.stdout);
  }
  if (update.stderr) {
    process.stderr.write(update.stderr);
  }

  if (update.status !== 0) {
    const combinedOutput = `${update.stdout ?? ''}\n${update.stderr ?? ''}`;
    if (isWorkspaceProtocolInstallFailure(combinedOutput)) {
      const fallbackVersion = findLatestInstallableNpmVersion(info.packageName, current);
      if (fallbackVersion) {
        if (compareVersions(fallbackVersion, current) <= 0) {
          console.warn(
            'Latest npm version is not installable via npm (workspace: dependency metadata). ' +
              `Staying on ${current}.`
          );
          return;
        }

        console.warn(
          'Latest npm version is not installable via npm (workspace: dependency metadata). ' +
            `Trying ${fallbackVersion}...`
        );

        const fallback = spawnSync('npm', ['install', '-g', `${info.packageName}@${fallbackVersion}`], {
          encoding: 'utf8',
        });

        if (fallback.stdout) {
          process.stdout.write(fallback.stdout);
        }
        if (fallback.stderr) {
          process.stderr.write(fallback.stderr);
        }

        if (fallback.status !== 0) {
          throw new Error(
            `npm update failed with exit code ${update.status ?? 'unknown'}; fallback ` +
              `${fallbackVersion} failed with exit code ${fallback.status ?? 'unknown'}`
          );
        }

        const refreshed = detectNpmInstall([info.packageName]);
        const finalVersion = refreshed?.version ?? fallbackVersion;
        console.log(`Updated ${info.packageName} to ${finalVersion}.`);
        console.log('- note: latest npm version is currently not installable via npm');
        return;
      }

      throw new Error(
        'npm update failed because the latest npm version references workspace: dependency ranges, ' +
          'which npm cannot install globally'
      );
    }

    throw new Error(`npm update failed with exit code ${update.status ?? 'unknown'}`);
  }

  const refreshed = detectNpmInstall([info.packageName]);
  const finalVersion = refreshed?.version ?? 'unknown';
  console.log(`Updated ${info.packageName} to ${finalVersion}.`);
}

function getNpmLatestVersion(packageName: string): string | undefined {
  const view = spawnSync('npm', ['view', packageName, 'version'], {
    encoding: 'utf8',
  });

  if (view.status !== 0) {
    return undefined;
  }

  const version = view.stdout.trim();
  return version.length > 0 ? version : undefined;
}

function findLatestInstallableNpmVersion(
  packageName: string,
  currentVersion: string
): string | undefined {
  const versions = getNpmVersions(packageName);
  if (!versions || versions.length === 0) {
    return undefined;
  }

  const sortedCandidates = versions
    .filter((version) => compareVersions(version, currentVersion) >= 0)
    .sort((left, right) => compareVersions(right, left));

  for (const version of sortedCandidates) {
    const manifest = getNpmManifest(packageName, version);
    if (manifest && !manifestUsesWorkspaceProtocol(manifest)) {
      return version;
    }
  }

  return undefined;
}

function getNpmVersions(packageName: string): string[] | undefined {
  const view = spawnSync('npm', ['view', packageName, 'versions', '--json'], {
    encoding: 'utf8',
  });

  if (view.status !== 0) {
    return undefined;
  }

  const parsed = tryParseJson<unknown>(view.stdout);
  if (Array.isArray(parsed)) {
    return parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  }

  if (typeof parsed === 'string' && parsed.trim().length > 0) {
    return [parsed.trim()];
  }

  return undefined;
}

function getNpmManifest(packageName: string, version: string): NpmPackageManifest | undefined {
  const view = spawnSync('npm', ['view', `${packageName}@${version}`, '--json'], {
    encoding: 'utf8',
  });

  if (view.status !== 0) {
    return undefined;
  }

  const parsed = tryParseJson<unknown>(view.stdout);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }

  return parsed as NpmPackageManifest;
}

function manifestUsesWorkspaceProtocol(manifest: NpmPackageManifest): boolean {
  return (
    dependencyMapUsesWorkspaceProtocol(manifest.dependencies) ||
    dependencyMapUsesWorkspaceProtocol(manifest.optionalDependencies) ||
    dependencyMapUsesWorkspaceProtocol(manifest.peerDependencies)
  );
}

function dependencyMapUsesWorkspaceProtocol(map: Record<string, string> | undefined): boolean {
  if (!map) {
    return false;
  }

  return Object.values(map).some((value) => {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return normalized.startsWith('workspace:');
  });
}

function isWorkspaceProtocolInstallFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes('eunsupportedprotocol') &&
    normalized.includes('workspace:') &&
    normalized.includes('unsupported url type')
  );
}

function updateGithubInstall(repoRoot: string, checkOnly: boolean): void {
  if (!isCommandAvailable('git')) {
    throw new Error('git is required for source update.');
  }

  const branch = resolveOriginBranch(repoRoot);
  const remoteRef = `origin/${branch}`;
  const localVersion = readLocalVersion(repoRoot);

  console.log(`- source repo: ${repoRoot}`);
  console.log(`- tracking branch: ${remoteRef}`);
  console.log(`- installed version: ${localVersion}`);

  runOrThrow('git', ['fetch', 'origin', branch, '--tags'], repoRoot, false);

  const remoteVersion = readRemoteVersion(repoRoot, remoteRef);
  if (remoteVersion) {
    console.log(`- latest github version: ${remoteVersion}`);
  } else {
    console.log('- latest github version: unknown (package.json unavailable on remote ref)');
  }

  const { ahead, behind } = readAheadBehind(repoRoot, remoteRef);
  console.log(`- commit delta (ahead/behind): ${ahead}/${behind}`);

  const versionOutdated =
    remoteVersion !== undefined ? compareVersions(localVersion, remoteVersion) < 0 : false;
  const needsUpdate = behind > 0 || versionOutdated;

  if (!needsUpdate) {
    console.log('Already up to date.');
    return;
  }

  if (checkOnly) {
    console.log('Update available.');
    return;
  }

  if (hasUncommittedChanges(repoRoot)) {
    throw new Error('Repository has local changes. Commit/stash them before running `keygate update`.');
  }

  ensurePnpmAvailable();

  runOrThrow('git', ['pull', '--rebase', 'origin', branch], repoRoot, true);
  runOrThrow('pnpm', ['install'], repoRoot, true);
  runOrThrow('pnpm', ['build'], repoRoot, true);

  const finalVersion = readLocalVersion(repoRoot);
  console.log(`Updated source install to ${finalVersion}.`);
}

function resolveOriginBranch(repoRoot: string): string {
  const symbolic = spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (symbolic.status !== 0) {
    return 'main';
  }

  const ref = symbolic.stdout.trim();
  if (!ref.startsWith('origin/')) {
    return 'main';
  }

  return ref.slice('origin/'.length);
}

function readLocalVersion(repoRoot: string): string {
  const pkg = readJsonFile<{ version?: string }>(path.join(repoRoot, 'package.json'));
  return pkg?.version?.trim() || '0.0.0';
}

function readRemoteVersion(repoRoot: string, remoteRef: string): string | undefined {
  const show = spawnSync('git', ['show', `${remoteRef}:package.json`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (show.status !== 0) {
    return undefined;
  }

  const pkg = tryParseJson<{ version?: string }>(show.stdout);
  const version = pkg?.version?.trim();
  return version && version.length > 0 ? version : undefined;
}

function readAheadBehind(repoRoot: string, remoteRef: string): { ahead: number; behind: number } {
  const counts = spawnSync('git', ['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (counts.status !== 0) {
    return { ahead: 0, behind: 0 };
  }

  const parts = counts.stdout.trim().split(/\s+/g);
  const ahead = Number.parseInt(parts[0] ?? '0', 10);
  const behind = Number.parseInt(parts[1] ?? '0', 10);

  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
}

function hasUncommittedChanges(repoRoot: string): boolean {
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (status.status !== 0) {
    return true;
  }

  return status.stdout.trim().length > 0;
}

function ensurePnpmAvailable(): void {
  if (isCommandAvailable('pnpm')) {
    return;
  }

  if (!isCommandAvailable('corepack')) {
    throw new Error('pnpm is not available and corepack is missing. Install pnpm and retry.');
  }

  runOrThrow('corepack', ['enable'], process.cwd(), true);
  runOrThrow('corepack', ['prepare', 'pnpm@9.15.0', '--activate'], process.cwd(), true);

  if (!isCommandAvailable('pnpm')) {
    throw new Error('Failed to activate pnpm via corepack.');
  }
}

function isCommandAvailable(command: string): boolean {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
  });

  return !result.error && result.status === 0;
}

function runOrThrow(
  command: string,
  args: string[],
  cwd: string,
  inheritStdio: boolean
): void {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: inheritStdio ? 'inherit' : 'pipe',
  });

  if (result.status === 0) {
    return;
  }

  if (!inheritStdio) {
    const stderr = result.stderr?.toString().trim();
    const stdout = result.stdout?.toString().trim();
    if (stderr) {
      throw new Error(stderr);
    }
    if (stdout) {
      throw new Error(stdout);
    }
  }

  throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
}

function compareVersions(a: string, b: string): number {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);

  if (!parsedA || !parsedB) {
    if (a === b) {
      return 0;
    }
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }

  if (parsedA.major !== parsedB.major) {
    return parsedA.major - parsedB.major;
  }
  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor - parsedB.minor;
  }
  return parsedA.patch - parsedB.patch;
}

function parseSemver(version: string): { major: number; minor: number; patch: number } | undefined {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    return undefined;
  }

  const major = Number.parseInt(match[1]!, 10);
  const minor = Number.parseInt(match[2]!, 10);
  const patch = Number.parseInt(match[3]!, 10);

  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return undefined;
  }

  return { major, minor, patch };
}

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function tryParseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}
