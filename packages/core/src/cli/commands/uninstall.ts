import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { hasFlag, type ParsedArgs } from '../argv.js';

interface NpmUninstallResult {
  packageName: string;
  removed: boolean;
  skipped: boolean;
  detail: string;
}

interface PathRemovalResult {
  path: string;
  removed: boolean;
  skipped: boolean;
  detail: string;
}

export async function runUninstallCommand(args: ParsedArgs): Promise<void> {
  const confirmBypass = hasFlag(args.flags, 'yes') || hasFlag(args.flags, 'y');
  const removeConfig = hasFlag(args.flags, 'remove-config');
  const removeWorkspace = hasFlag(args.flags, 'remove-workspace');
  const npmPackage = process.env['KEYGATE_NPM_PACKAGE']?.trim() || '@puukis/cli';
  const legacyNpmPackage = '@keygate/cli';

  const targets = getRemovalTargets({ removeConfig, removeWorkspace });
  const existingTargets = await filterExistingPaths(targets);

  console.log('Keygate uninstall');
  console.log(`- npm package target: ${npmPackage}`);
  if (existingTargets.length > 0) {
    console.log('- local targets to remove:');
    for (const target of existingTargets) {
      console.log(`  - ${target}`);
    }
  } else {
    console.log('- no local install artifacts detected');
  }

  if (!removeConfig) {
    console.log(`- keeping config: ${path.join(os.homedir(), '.config', 'keygate')}`);
  }
  if (!removeWorkspace) {
    console.log(`- keeping workspace: ${path.join(os.homedir(), 'keygate-workspace')}`);
  }

  if (!confirmBypass) {
    const confirmed = await confirmUninstall();
    if (!confirmed) {
      console.log('Uninstall cancelled.');
      return;
    }
  }

  const npmResults = uninstallNpmPackages([npmPackage, legacyNpmPackage, 'keygate']);
  const pathResults = await removePaths(existingTargets);

  console.log('');
  console.log('Uninstall summary:');
  for (const result of npmResults) {
    const prefix = result.removed ? '✓' : result.skipped ? '-' : '!';
    console.log(`${prefix} npm ${result.packageName}: ${result.detail}`);
  }

  for (const result of pathResults) {
    const prefix = result.removed ? '✓' : result.skipped ? '-' : '!';
    console.log(`${prefix} ${result.path}: ${result.detail}`);
  }
}

async function confirmUninstall(): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error('Non-interactive shell detected. Re-run with --yes to confirm uninstall.');
  }

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question('Continue and uninstall Keygate? [y/N] ');
    return /^[Yy]$/.test(answer.trim());
  } finally {
    rl.close();
  }
}

function uninstallNpmPackages(packageNames: string[]): NpmUninstallResult[] {
  const uniqueNames = Array.from(new Set(packageNames.filter(Boolean)));
  if (uniqueNames.length === 0) {
    return [];
  }

  const npmAvailable = isNpmAvailable();
  if (!npmAvailable) {
    return uniqueNames.map((packageName) => ({
      packageName,
      removed: false,
      skipped: true,
      detail: 'npm not found; skipped',
    }));
  }

  return uniqueNames.map((packageName) => {
    if (!isPackageInstalled(packageName)) {
      return {
        packageName,
        removed: false,
        skipped: true,
        detail: 'not installed',
      };
    }

    const result = spawnSync('npm', ['uninstall', '-g', packageName], {
      encoding: 'utf8',
    });

    if (result.status === 0) {
      return {
        packageName,
        removed: true,
        skipped: false,
        detail: 'removed',
      };
    }

    const message = normalizeSpawnMessage(result);
    return {
      packageName,
      removed: false,
      skipped: false,
      detail: message,
    };
  });
}

function isNpmAvailable(): boolean {
  const check = spawnSync('npm', ['--version'], {
    encoding: 'utf8',
  });

  return !check.error && check.status === 0;
}

function isPackageInstalled(packageName: string): boolean {
  const result = spawnSync('npm', ['list', '-g', '--depth=0', packageName], {
    encoding: 'utf8',
  });

  return result.status === 0;
}

function normalizeSpawnMessage(result: ReturnType<typeof spawnSync>): string {
  if (result.error) {
    return result.error.message;
  }

  const stderr = (result.stderr ?? '').toString().trim();
  if (stderr.length > 0) {
    return stderr;
  }

  const stdout = (result.stdout ?? '').toString().trim();
  if (stdout.length > 0) {
    return stdout;
  }

  return `failed with exit code ${result.status ?? 'unknown'}`;
}

function getRemovalTargets(options: { removeConfig: boolean; removeWorkspace: boolean }): string[] {
  const homeDir = os.homedir();
  const targets = [
    path.join(homeDir, '.local', 'bin', 'keygate'),
    path.join(homeDir, '.local', 'share', 'keygate'),
    path.join(homeDir, 'keygate-bin', 'keygate.cmd'),
  ];

  const localAppData = process.env['LOCALAPPDATA'];
  if (localAppData) {
    targets.push(path.join(localAppData, 'keygate'));
  }

  if (options.removeConfig) {
    targets.push(path.join(homeDir, '.config', 'keygate'));
  }

  if (options.removeWorkspace) {
    targets.push(path.join(homeDir, 'keygate-workspace'));
  }

  return Array.from(new Set(targets));
}

async function filterExistingPaths(paths: string[]): Promise<string[]> {
  const checks = await Promise.all(
    paths.map(async (targetPath) => ({
      path: targetPath,
      exists: await pathExists(targetPath),
    }))
  );

  return checks.filter((entry) => entry.exists).map((entry) => entry.path);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function removePaths(paths: string[]): Promise<PathRemovalResult[]> {
  const results: PathRemovalResult[] = [];

  for (const targetPath of paths) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
      results.push({
        path: targetPath,
        removed: true,
        skipped: false,
        detail: 'removed',
      });
    } catch (error) {
      results.push({
        path: targetPath,
        removed: false,
        skipped: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
