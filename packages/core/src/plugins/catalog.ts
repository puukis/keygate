import path from 'node:path';
import type { KeygateConfig } from '../types.js';
import { getConfigDir } from '../config/env.js';
import { collectReservedCliCommands, findPluginManifestPaths, loadPluginManifest } from './manifest.js';
import type {
  PluginCatalogSnapshot,
  PluginDiagnostic,
  PluginSourceRoot,
  ResolvedPluginManifest,
} from './types.js';

export async function discoverPluginCatalog(config: KeygateConfig): Promise<PluginCatalogSnapshot> {
  const roots = buildPluginSourceRoots(config);
  const diagnostics: PluginDiagnostic[] = [];
  const manifests: ResolvedPluginManifest[] = [];
  const duplicates: Array<{ id: string; kept: string; dropped: string }> = [];
  const keptById = new Map<string, ResolvedPluginManifest>();

  for (const root of roots) {
    const manifestPaths = await findPluginManifestPaths(root.path);
    for (const manifestPath of manifestPaths) {
      let manifest: ResolvedPluginManifest;
      try {
        manifest = await loadPluginManifest(manifestPath, {
          sourceKind: root.sourceKind,
          scope: root.scope,
          precedence: root.precedence,
        });
      } catch (error) {
        diagnostics.push({
          location: manifestPath,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (manifest.id) {
        const existing = keptById.get(manifest.id);
        if (existing) {
          duplicates.push({
            id: manifest.id,
            kept: existing.manifestPath,
            dropped: manifest.manifestPath,
          });
          continue;
        }
        keptById.set(manifest.id, manifest);
      }

      manifests.push(manifest);
    }
  }

  const commandCollisions = findCommandCollisions(
    manifests.filter((manifest) => manifest.runtimeCapable && isPluginEnabled(config, manifest))
  );

  return {
    roots,
    manifests,
    diagnostics,
    duplicates,
    commandCollisions,
    pluginSkillRoots: manifests
      .filter((manifest) => shouldExposeSkillRoots(config, manifest))
      .flatMap((manifest) => manifest.skillDirPaths),
  };
}

export function buildPluginSourceRoots(config: KeygateConfig): PluginSourceRoot[] {
  const workspaceRoot = path.resolve(expandHome(config.security.workspacePath), 'plugins');
  const globalRoot = path.join(getConfigDir(), 'plugins');
  const explicitRoots = normalizeRoots(config.plugins?.load.paths ?? []);
  const legacyRoots = explicitRoots.length === 0
    ? normalizeRoots(config.skills?.load.pluginDirs ?? [])
    : [];

  const ordered: PluginSourceRoot[] = [];
  let precedence = 500;

  for (const root of explicitRoots) {
    ordered.push({
      path: root,
      sourceKind: 'explicit',
      scope: null,
      precedence,
    });
    precedence -= 1;
  }

  for (const root of legacyRoots) {
    ordered.push({
      path: root,
      sourceKind: 'legacy',
      scope: null,
      precedence,
    });
    precedence -= 1;
  }

  ordered.push({
    path: workspaceRoot,
    sourceKind: 'workspace',
    scope: 'workspace',
    precedence: 400,
  });
  ordered.push({
    path: globalRoot,
    sourceKind: 'global',
    scope: 'global',
    precedence: 300,
  });

  const seen = new Set<string>();
  return ordered.filter((root) => {
    const key = path.resolve(root.path);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function findManifestById(
  catalog: PluginCatalogSnapshot,
  pluginId: string
): ResolvedPluginManifest | undefined {
  return catalog.manifests.find((manifest) => manifest.id === pluginId);
}

export function isPluginEnabled(config: KeygateConfig, manifest: Pick<ResolvedPluginManifest, 'id' | 'enabled'>): boolean {
  if (!manifest.enabled) {
    return false;
  }

  if (!manifest.id) {
    return true;
  }

  const entry = config.plugins?.entries?.[manifest.id];
  return entry?.enabled !== false;
}

export function shouldExposeSkillRoots(config: KeygateConfig, manifest: ResolvedPluginManifest): boolean {
  if (!isPluginEnabled(config, manifest)) {
    return false;
  }

  if (manifest.skillDirPaths.length === 0) {
    return false;
  }

  if (manifest.requiresConfig.length === 0) {
    return true;
  }

  const mergedConfig = config as unknown as Record<string, unknown>;
  return manifest.requiresConfig.every((configPath) => isTruthyPath(mergedConfig, configPath));
}

export function buildBuiltinCommandSet(): Set<string> {
  return new Set([
    'onboard',
    'onboarding',
    'auth',
    'install',
    'uninstall',
    'update',
    'gateway',
    'channels',
    'mcp',
    'tui',
    'skills',
    'memory',
    'pairing',
    'doctor',
    'plugins',
    'help',
  ]);
}

function findCommandCollisions(
  manifests: ResolvedPluginManifest[]
): Array<{ command: string; pluginIds: string[] }> {
  const commandOwners = new Map<string, string[]>();
  const builtins = buildBuiltinCommandSet();

  for (const manifest of manifests) {
    if (!manifest.id) {
      continue;
    }

    for (const command of collectReservedCliCommands(manifest)) {
      const owners = commandOwners.get(command) ?? [];
      owners.push(manifest.id);
      commandOwners.set(command, owners);
    }
  }

  const collisions: Array<{ command: string; pluginIds: string[] }> = [];
  for (const [command, pluginIds] of commandOwners) {
    const uniqueIds = Array.from(new Set(pluginIds));
    if (uniqueIds.length > 1 || builtins.has(command)) {
      collisions.push({
        command,
        pluginIds: uniqueIds,
      });
    }
  }

  return collisions.sort((left, right) => left.command.localeCompare(right.command));
}

function normalizeRoots(values: string[]): string[] {
  return values
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(expandHome(entry)));
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
