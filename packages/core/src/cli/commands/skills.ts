import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { ParsedArgs } from '../argv.js';
import { getFlagString, hasFlag } from '../argv.js';
import { loadConfigFromEnv } from '../../config/env.js';
import { SkillsManager } from '../../skills/index.js';

export async function runSkillsCommand(args: ParsedArgs): Promise<void> {
  const action = args.positional[1] ?? 'list';
  const config = loadConfigFromEnv();
  const manager = new SkillsManager({ config });

  await manager.ensureReady();

  switch (action) {
    case 'list':
      await runList(manager, args);
      return;
    case 'doctor':
      await runDoctor(manager, args);
      return;
    case 'validate':
      await runValidate(manager, args);
      return;
    case 'where':
      await runWhere(manager);
      return;
    case 'install':
      await runInstall(manager, args);
      return;
    case 'update':
      await runUpdate(manager, args);
      return;
    case 'remove':
      await runRemove(manager, args);
      return;
    default:
      throw new Error(`Unknown skills command: ${action}`);
  }
}

async function runList(manager: SkillsManager, args: ParsedArgs): Promise<void> {
  const includeAll = hasFlag(args.flags, 'all');
  const asJson = hasFlag(args.flags, 'json');
  const entries = await manager.listSkills('cli', includeAll);

  if (asJson) {
    console.log(JSON.stringify(entries.map((entry) => ({
      name: entry.skill.name,
      description: entry.skill.description,
      source: entry.skill.sourceType,
      location: entry.skill.location,
      eligible: entry.eligible,
      reason: entry.reason,
      userInvocable: entry.skill.userInvocable,
      commandDispatch: entry.skill.commandDispatch,
      commandTool: entry.skill.commandTool,
    })), null, 2));
    return;
  }

  if (entries.length === 0) {
    console.log(includeAll ? 'No skills discovered.' : 'No eligible skills discovered.');
    return;
  }

  for (const entry of entries) {
    const status = entry.eligible ? 'eligible' : `ineligible (${entry.reason})`;
    console.log(`- ${entry.skill.name} [${entry.skill.sourceType}] ${status}`);
  }
}

async function runDoctor(manager: SkillsManager, args: ParsedArgs): Promise<void> {
  const nameFilter = getFlagString(args.flags, 'name', '').trim().toLowerCase();
  const asJson = hasFlag(args.flags, 'json');
  const report = await manager.getDoctorReport('doctor');

  const records = report.records.filter((record) => (
    !nameFilter || record.skill.name.toLowerCase() === nameFilter
  ));

  if (asJson) {
    console.log(JSON.stringify({
      snapshotVersion: report.snapshotVersion,
      records: records.map((record) => ({
        name: record.skill.name,
        source: record.skill.sourceType,
        location: record.skill.location,
        eligible: record.eligible,
        reason: record.reason,
        entryKey: record.entryKey,
        envOverlayKeys: Object.keys(record.envOverlay),
      })),
      conflicts: report.conflicts,
      diagnostics: report.diagnostics,
    }, null, 2));
    return;
  }

  console.log(`snapshot: ${report.snapshotVersion}`);

  if (records.length === 0) {
    console.log('No matching skills in doctor report.');
  } else {
    for (const record of records) {
      console.log(`- ${record.skill.name}: ${record.eligible ? 'eligible' : `ineligible (${record.reason})`}`);
    }
  }

  if (report.conflicts.length > 0) {
    console.log('\nconflicts:');
    for (const conflict of report.conflicts) {
      console.log(`- ${conflict.name}: kept=${conflict.kept.location} dropped=${conflict.dropped.location}`);
    }
  }

  if (report.diagnostics.length > 0) {
    console.log('\ndiagnostics:');
    for (const diagnostic of report.diagnostics) {
      console.log(`- ${diagnostic.location}: ${diagnostic.error}`);
    }
  }
}

async function runValidate(manager: SkillsManager, args: ParsedArgs): Promise<void> {
  const validateAll = hasFlag(args.flags, 'all');
  const explicitPath = getFlagString(args.flags, 'path', '').trim();
  const roots: string[] = [];

  if (explicitPath.length > 0) {
    roots.push(explicitPath);
  } else if (validateAll) {
    const sourceRoots = manager.getSourceRoots();
    if (!sourceRoots) {
      throw new Error('No source roots available for validation.');
    }

    roots.push(
      sourceRoots.workspaceRoot,
      sourceRoots.globalRoot,
      ...sourceRoots.pluginSkillRoots,
      ...sourceRoots.bundledRoots,
      ...sourceRoots.extraRoots,
    );
  } else {
    roots.push(manager.getScopeRoot('workspace'));
  }

  const uniqueRoots = Array.from(new Set(roots.map((entry) => path.resolve(entry))));
  let totalValid = 0;
  let totalIssues = 0;

  for (const root of uniqueRoots) {
    const report = await manager.validateSkillPath(root);
    totalValid += report.valid.length;
    totalIssues += report.issues.length;

    console.log(`\n${root}`);
    for (const valid of report.valid) {
      console.log(`- valid: ${valid.name}`);
    }
    for (const issue of report.issues) {
      console.log(`- issue: ${issue.path}: ${issue.error}`);
    }
  }

  console.log(`\nvalidation summary: valid=${totalValid}, issues=${totalIssues}`);
  if (totalIssues > 0) {
    process.exitCode = 1;
  }
}

async function runWhere(manager: SkillsManager): Promise<void> {
  const roots = manager.getSourceRoots();
  if (!roots) {
    console.log('Skills source roots are not initialized.');
    return;
  }

  console.log(`workspace: ${roots.workspaceRoot}`);
  console.log(`global: ${roots.globalRoot}`);
  console.log(`plugin roots: ${roots.pluginRoots.join(', ') || '(none)'}`);
  console.log(`plugin skill roots: ${roots.pluginSkillRoots.join(', ') || '(none)'}`);
  console.log(`bundled: ${roots.bundledRoots.join(', ') || '(none)'}`);
  console.log(`extra: ${roots.extraRoots.join(', ') || '(none)'}`);
}

async function runInstall(manager: SkillsManager, args: ParsedArgs): Promise<void> {
  const source = args.positional[2]?.trim();
  if (!source) {
    throw new Error('Usage: keygate skills install <source> [--scope workspace|global] [--name <skill>|--all]');
  }

  const scope = normalizeScope(getFlagString(args.flags, 'scope', 'workspace'));
  const targetName = getFlagString(args.flags, 'name', '').trim();
  const installAll = hasFlag(args.flags, 'all');

  const installed = await installSkillsFromSource(manager, {
    source,
    scope,
    targetName,
    installAll,
  });

  if (installed.length === 0) {
    throw new Error('No skills installed. Check source path and --name/--all filters.');
  }

  console.log(`Installed ${installed.length} skill(s): ${installed.join(', ')}`);
}

async function runUpdate(manager: SkillsManager, args: ParsedArgs): Promise<void> {
  const target = args.positional[2]?.trim() ?? '';
  const updateAll = hasFlag(args.flags, 'all') || target === '--all';
  const explicitScope = getFlagString(args.flags, 'scope', '').trim();
  const scopes = explicitScope ? [normalizeScope(explicitScope)] : (['workspace', 'global'] as const);

  const updated: string[] = [];

  for (const scope of scopes) {
    const state = await manager.loadInstallState(scope);
    const entries = Object.values(state.records);

    for (const record of entries) {
      if (!updateAll && target.length > 0 && record.name !== target) {
        continue;
      }

      const installed = await installSkillsFromSource(manager, {
        source: record.source,
        scope: record.scope,
        targetName: record.name,
        installAll: false,
      });

      updated.push(...installed.map((name) => `${name} (${scope})`));
    }
  }

  if (updated.length === 0) {
    throw new Error('No installed skill records matched for update.');
  }

  console.log(`Updated ${updated.length} skill(s): ${updated.join(', ')}`);
}

async function runRemove(manager: SkillsManager, args: ParsedArgs): Promise<void> {
  const target = args.positional[2]?.trim();
  if (!target) {
    throw new Error('Usage: keygate skills remove <name> [--scope workspace|global]');
  }

  const scope = normalizeScope(getFlagString(args.flags, 'scope', 'workspace'));
  const root = manager.getScopeRoot(scope);
  const targetDir = path.join(root, target);

  await fs.rm(targetDir, { recursive: true, force: true });

  const state = await manager.loadInstallState(scope);
  if (state.records[target]) {
    delete state.records[target];
    await manager.saveInstallState(scope, state);
  }

  await manager.refresh();
  console.log(`Removed skill ${target} from ${scope}.`);
}

async function installSkillsFromSource(
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

async function resolveSourceDirectory(source: string): Promise<{ path: string; cleanup?: () => Promise<void> }> {
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

async function discoverSkillDirs(root: string): Promise<string[]> {
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

function normalizeScope(value: string): 'workspace' | 'global' {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'global') {
    return 'global';
  }

  if (normalized === 'workspace') {
    return 'workspace';
  }

  throw new Error(`Invalid scope "${value}". Expected workspace or global.`);
}

function looksLikeGitSource(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://') || value.startsWith('git@') || value.endsWith('.git');
}

function expandHome(value: string): string {
  if (value === '~') {
    return os.homedir();
  }

  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
