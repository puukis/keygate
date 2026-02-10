import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getConfigDir } from '../config/env.js';
import type { KeygateConfig, SkillDefinition, SkillSourceType } from '../types.js';
import { parseSkillAtPath } from './parser.js';
import { discoverPluginSkillDirs } from './pluginManifest.js';
import type {
  DiscoveredSkill,
  DiscoveryDiagnostic,
  SkillConflict,
  SkillDiscoverySnapshot,
  SkillSourceRoots,
} from './types.js';

const SOURCE_PRECEDENCE: Record<SkillSourceType, number> = {
  workspace: 500,
  global: 400,
  plugin: 300,
  bundled: 200,
  extra: 100,
};

export async function discoverSkills(config: KeygateConfig): Promise<SkillDiscoverySnapshot> {
  const mergedConfig = config as unknown as Record<string, unknown>;
  const sourceRoots = await resolveSourceRoots(config, mergedConfig);

  const diagnostics: DiscoveryDiagnostic[] = [];
  diagnostics.push(...sourceRoots.pluginDiagnostics);

  const discovered: DiscoveredSkill[] = [];

  await collectFromRoot(discovered, diagnostics, sourceRoots.workspaceRoot, 'workspace', 0);
  await collectFromRoot(discovered, diagnostics, sourceRoots.globalRoot, 'global', 0);

  for (let index = 0; index < sourceRoots.pluginSkillRoots.length; index += 1) {
    await collectFromRoot(discovered, diagnostics, sourceRoots.pluginSkillRoots[index]!, 'plugin', index);
  }

  for (let index = 0; index < sourceRoots.bundledRoots.length; index += 1) {
    await collectFromRoot(discovered, diagnostics, sourceRoots.bundledRoots[index]!, 'bundled', index);
  }

  for (let index = 0; index < sourceRoots.extraRoots.length; index += 1) {
    await collectFromRoot(discovered, diagnostics, sourceRoots.extraRoots[index]!, 'extra', index);
  }

  const merged = mergeByPrecedence(discovered);

  return {
    loaded: merged.loaded,
    conflicts: merged.conflicts,
    diagnostics,
    sourceRoots: {
      workspaceRoot: sourceRoots.workspaceRoot,
      globalRoot: sourceRoots.globalRoot,
      bundledRoots: sourceRoots.bundledRoots,
      extraRoots: sourceRoots.extraRoots,
      pluginRoots: sourceRoots.pluginRoots,
      pluginSkillRoots: sourceRoots.pluginSkillRoots,
    },
    snapshotVersion: computeSnapshotVersion(merged.loaded),
  };
}

export function computeSnapshotVersion(skills: SkillDefinition[]): string {
  const payload = skills
    .map((skill) => `${skill.name}|${skill.location}|${skill.sourceType}|${skill.description}|${skill.body.length}`)
    .sort()
    .join('\n');

  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function resolveBundledSkillRoots(): string[] {
  const skillsDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(skillsDir, '../bundled-skills'),
    path.resolve(skillsDir, '../../skills'),
  ];

  return Array.from(new Set(candidates));
}

interface ResolvedSourceRoots extends SkillSourceRoots {
  pluginDiagnostics: DiscoveryDiagnostic[];
}

async function resolveSourceRoots(
  config: KeygateConfig,
  mergedConfig: Record<string, unknown>
): Promise<ResolvedSourceRoots> {
  const workspacePath = path.resolve(expandHome(config.security.workspacePath));
  const workspaceRoot = path.join(workspacePath, 'skills');

  const configDir = getConfigDir();
  const globalRoot = path.join(configDir, 'skills');

  const bundledRoots = resolveBundledSkillRoots().map((entry) => path.resolve(expandHome(entry)));

  const extraRoots = (config.skills?.load.extraDirs ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(expandHome(entry)));

  const pluginRoots = (config.skills?.load.pluginDirs ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(expandHome(entry)));

  const pluginDiscovery = await discoverPluginSkillDirs(pluginRoots, mergedConfig);

  return {
    workspaceRoot,
    globalRoot,
    bundledRoots,
    extraRoots,
    pluginRoots,
    pluginSkillRoots: pluginDiscovery.pluginSkillRoots,
    pluginDiagnostics: pluginDiscovery.diagnostics,
  };
}

async function collectFromRoot(
  target: DiscoveredSkill[],
  diagnostics: DiscoveryDiagnostic[],
  root: string,
  sourceType: SkillSourceType,
  rootIndex: number
): Promise<void> {
  const resolvedRoot = path.resolve(expandHome(root));
  const stat = await safeStat(resolvedRoot);
  if (!stat || !stat.isDirectory()) {
    return;
  }

  const rootSkillFile = path.join(resolvedRoot, 'SKILL.md');
  const hasRootSkill = await pathExists(rootSkillFile);

  if (hasRootSkill) {
    const parsed = await parseSkillAtPath(resolvedRoot, sourceType);
    if (parsed.ok) {
      target.push({
        skill: parsed.value,
        precedence: SOURCE_PRECEDENCE[sourceType] - rootIndex,
      });
    } else {
      diagnostics.push({
        location: rootSkillFile,
        error: parsed.error,
      });
    }
  }

  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(resolvedRoot, { withFileTypes: true });
  } catch (error) {
    diagnostics.push({
      location: resolvedRoot,
      error: `Failed to read directory: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillDir = path.join(resolvedRoot, entry.name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!(await pathExists(skillFile))) {
      continue;
    }

    const parsed = await parseSkillAtPath(skillDir, sourceType);
    if (!parsed.ok) {
      diagnostics.push({
        location: skillFile,
        error: parsed.error,
      });
      continue;
    }

    target.push({
      skill: parsed.value,
      precedence: SOURCE_PRECEDENCE[sourceType] - rootIndex,
    });
  }
}

function mergeByPrecedence(discovered: DiscoveredSkill[]): { loaded: SkillDefinition[]; conflicts: SkillConflict[] } {
  const byName = new Map<string, DiscoveredSkill>();
  const conflicts: SkillConflict[] = [];

  for (const candidate of discovered) {
    const existing = byName.get(candidate.skill.name);
    if (!existing) {
      byName.set(candidate.skill.name, candidate);
      continue;
    }

    if (candidate.precedence > existing.precedence) {
      byName.set(candidate.skill.name, candidate);
      conflicts.push({
        name: candidate.skill.name,
        kept: candidate.skill,
        dropped: existing.skill,
      });
    } else {
      conflicts.push({
        name: candidate.skill.name,
        kept: existing.skill,
        dropped: candidate.skill,
      });
    }
  }

  const loaded = Array.from(byName.values())
    .map((entry) => entry.skill)
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    loaded,
    conflicts,
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function safeStat(targetPath: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(targetPath);
  } catch {
    return null;
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
