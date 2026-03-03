import path from 'node:path';
import { findPluginManifestPaths, loadPluginManifest } from '../plugins/manifest.js';
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
      try {
        const manifest = await loadPluginManifest(manifestPath, {
          sourceKind: 'legacy',
          scope: null,
          precedence: 0,
        });

        if (!manifest.enabled) {
          continue;
        }

        if (manifest.requiresConfig.some((configPath) => !isTruthyPath(mergedConfig, configPath))) {
          continue;
        }

        pluginSkillRoots.push(...manifest.skillDirPaths.map((entry) => path.resolve(entry)));
      } catch (error) {
        diagnostics.push({
          location: manifestPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    pluginSkillRoots: unique(pluginSkillRoots),
    diagnostics,
  };
}

export async function readPluginManifest(filePath: string): Promise<SkillPluginManifest> {
  const manifest = await loadPluginManifest(filePath, {
    sourceKind: 'legacy',
    scope: null,
    precedence: 0,
  });

  return {
    name: manifest.name,
    enabled: manifest.enabled,
    skillsDirs: [...manifest.skillsDirs],
    requiresConfig: [...manifest.requiresConfig],
  };
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
