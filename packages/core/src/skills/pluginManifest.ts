import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import type { SkillPluginManifest } from './types.js';

export async function discoverPluginSkillDirs(
  pluginRoots: string[],
  mergedConfig: Record<string, unknown>
): Promise<{ pluginSkillRoots: string[]; diagnostics: Array<{ location: string; error: string }> }> {
  const diagnostics: Array<{ location: string; error: string }> = [];
  const pluginSkillRoots: string[] = [];

  for (const root of pluginRoots) {
    const manifestPaths = await findPluginManifestPaths(root);

    for (const manifestPath of manifestPaths) {
      let parsed: SkillPluginManifest;
      try {
        parsed = await readPluginManifest(manifestPath);
      } catch (error) {
        diagnostics.push({
          location: manifestPath,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (!parsed.enabled) {
        continue;
      }

      if (parsed.requiresConfig.some((configPath) => !isTruthyPath(mergedConfig, configPath))) {
        continue;
      }

      const manifestDir = path.dirname(manifestPath);
      for (const relativeSkillsDir of parsed.skillsDirs) {
        const resolved = path.resolve(manifestDir, relativeSkillsDir);
        pluginSkillRoots.push(resolved);
      }
    }
  }

  return {
    pluginSkillRoots: unique(pluginSkillRoots),
    diagnostics,
  };
}

async function findPluginManifestPaths(pluginRoot: string): Promise<string[]> {
  const manifests: string[] = [];
  const rootManifest = path.join(pluginRoot, 'keygate.plugin.json');

  if (await pathExists(rootManifest)) {
    manifests.push(rootManifest);
  }

  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(pluginRoot, { withFileTypes: true });
  } catch {
    return manifests;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const nestedManifest = path.join(pluginRoot, entry.name, 'keygate.plugin.json');
    if (await pathExists(nestedManifest)) {
      manifests.push(nestedManifest);
    }
  }

  return manifests;
}

async function readPluginManifest(filePath: string): Promise<SkillPluginManifest> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  const name = typeof parsed['name'] === 'string' ? parsed['name'].trim() : '';
  if (!name) {
    throw new Error('Plugin manifest requires non-empty "name"');
  }

  const enabled = parsed['enabled'] !== false;

  const skillsDirsValue = parsed['skillsDirs'];
  if (!Array.isArray(skillsDirsValue) || skillsDirsValue.length === 0) {
    throw new Error('Plugin manifest requires non-empty "skillsDirs" array');
  }

  const skillsDirs = skillsDirsValue
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (skillsDirs.length === 0) {
    throw new Error('Plugin manifest has no valid "skillsDirs" entries');
  }

  const requiresConfigValue = parsed['requiresConfig'];
  const requiresConfig = Array.isArray(requiresConfigValue)
    ? requiresConfigValue.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];

  return {
    name,
    enabled,
    skillsDirs,
    requiresConfig,
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isTruthyPath(root: Record<string, unknown>, dottedPath: string): boolean {
  const segments = dottedPath.split('.').map((value) => value.trim()).filter(Boolean);
  if (segments.length === 0) {
    return false;
  }

  let current: unknown = root;
  for (const segment of segments) {
    if (!current || typeof current !== 'object') {
      return false;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return Boolean(current);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
