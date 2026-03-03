import type { ParsedArgs } from '../argv.js';
import { getFlagString, hasFlag } from '../argv.js';
import { loadConfigFromEnv, savePersistedConfigObject } from '../../config/env.js';
import { Gateway } from '../../gateway/index.js';
import { buildPluginSourceRoots, discoverPluginCatalog, findManifestById, isPluginEnabled } from '../../plugins/catalog.js';
import {
  installPluginFromSource,
  loadPluginInstallState,
  removeInstalledPlugin,
  updateInstalledPlugin,
} from '../../plugins/installer.js';
import { validatePluginConfig } from '../../plugins/schema.js';
import type { PluginScope, ResolvedPluginManifest } from '../../plugins/types.js';

export async function runPluginsCommand(args: ParsedArgs): Promise<void> {
  const action = args.positional[1] ?? 'list';
  const config = loadConfigFromEnv();
  const runtime = Gateway.peekInstance()?.plugins ?? null;

  switch (action) {
    case 'list':
      await runList(config, args);
      return;
    case 'info':
      await runInfo(config, args);
      return;
    case 'install': {
      const source = args.positional[2]?.trim();
      if (!source) {
        throw new Error('Usage: keygate plugins install <source> [--scope workspace|global] [--link]');
      }

      if (runtime) {
        const info = await runtime.installPlugin({
          source,
          scope: normalizeScope(getFlagString(args.flags, 'scope', 'workspace')),
          link: hasFlag(args.flags, 'link'),
        });
        printPluginSummary(info);
        return;
      }

      const result = await installPluginFromSource(config, {
        source,
        scope: normalizeScope(getFlagString(args.flags, 'scope', 'workspace')),
        link: hasFlag(args.flags, 'link'),
        nodeManager: config.plugins?.install.nodeManager ?? 'npm',
      });
      await persistPluginEnabled(result.manifest.id!, true);
      console.log(`Installed plugin ${result.manifest.id} from ${source}`);
      return;
    }
    case 'update': {
      const target = args.positional[2]?.trim() ?? '';
      const updateAll = hasFlag(args.flags, 'all') || target === '--all';
      if (runtime) {
        const infos = await runtime.updatePlugin(updateAll ? undefined : target);
        for (const info of infos) {
          printPluginSummary(info);
        }
        return;
      }

      if (updateAll) {
        const stateWorkspace = await loadPluginInstallState(config, 'workspace');
        const stateGlobal = await loadPluginInstallState(config, 'global');
        const ids = Array.from(new Set([
          ...Object.keys(stateWorkspace.records),
          ...Object.keys(stateGlobal.records),
        ]));
        for (const id of ids) {
          await updateInstalledPlugin(config, id);
          console.log(`Updated ${id}`);
        }
        return;
      }

      if (!target) {
        throw new Error('Usage: keygate plugins update <id|--all>');
      }

      await updateInstalledPlugin(config, target);
      console.log(`Updated ${target}`);
      return;
    }
    case 'remove': {
      const pluginId = args.positional[2]?.trim();
      if (!pluginId) {
        throw new Error('Usage: keygate plugins remove <id> [--purge]');
      }

      if (runtime) {
        const removed = await runtime.removePlugin(pluginId, hasFlag(args.flags, 'purge'));
        console.log(removed ? `Removed ${pluginId}` : `Plugin not installed: ${pluginId}`);
        return;
      }

      const removed = await removeInstalledPlugin(config, pluginId);
      if (removed) {
        await persistPluginEnabled(pluginId, false, hasFlag(args.flags, 'purge'));
      }
      console.log(removed ? `Removed ${pluginId}` : `Plugin not installed: ${pluginId}`);
      return;
    }
    case 'enable': {
      const pluginId = args.positional[2]?.trim();
      if (!pluginId) {
        throw new Error('Usage: keygate plugins enable <id>');
      }

      if (runtime) {
        printPluginSummary(await runtime.enablePlugin(pluginId));
        return;
      }

      await persistPluginEnabled(pluginId, true);
      console.log(`Enabled ${pluginId}`);
      return;
    }
    case 'disable': {
      const pluginId = args.positional[2]?.trim();
      if (!pluginId) {
        throw new Error('Usage: keygate plugins disable <id>');
      }

      if (runtime) {
        printPluginSummary(await runtime.disablePlugin(pluginId));
        return;
      }

      await persistPluginEnabled(pluginId, false);
      console.log(`Disabled ${pluginId}`);
      return;
    }
    case 'reload': {
      const pluginId = args.positional[2]?.trim() || undefined;
      if (!runtime) {
        if (pluginId) {
          await assertPluginLoads(config, pluginId);
          console.log(`Validated ${pluginId}. No in-process gateway instance is running to hot-reload.`);
        } else {
          const catalog = await discoverPluginCatalog(config);
          for (const manifest of catalog.manifests.filter((entry) => entry.runtimeCapable && entry.id)) {
            await assertPluginLoads(config, manifest.id!);
          }
          console.log('Validated all runtime plugins. No in-process gateway instance is running to hot-reload.');
        }
        return;
      }

      const infos = await runtime.reloadPlugin(pluginId);
      for (const info of infos) {
        printPluginSummary(info);
      }
      return;
    }
    case 'config': {
      const subcommand = args.positional[2] ?? 'get';
      if (subcommand === 'get') {
        const pluginId = args.positional[3]?.trim();
        if (!pluginId) {
          throw new Error('Usage: keygate plugins config get <id> [--json]');
        }
        const entry = config.plugins?.entries?.[pluginId] ?? {};
        console.log(JSON.stringify(entry.config ?? {}, null, 2));
        return;
      }

      if (subcommand === 'set') {
        const pluginId = args.positional[3]?.trim();
        const rawJson = getFlagString(args.flags, 'json', '').trim();
        if (!pluginId || !rawJson) {
          throw new Error('Usage: keygate plugins config set <id> --json \'<object>\'');
        }

        const parsed = JSON.parse(rawJson) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Plugin config JSON must be an object.');
        }

        if (runtime) {
          printPluginSummary(await runtime.setPluginConfig(pluginId, parsed));
          return;
        }

        const catalog = await discoverPluginCatalog(config);
        const manifest = findManifestById(catalog, pluginId);
        if (!manifest) {
          throw new Error(`Unknown plugin: ${pluginId}`);
        }
        const validation = await validatePluginConfig(manifest, parsed);
        if (!validation.valid) {
          const detail = validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
          throw new Error(detail || 'Plugin config validation failed.');
        }
        await persistPluginConfig(pluginId, parsed);
        console.log(`Updated config for ${pluginId}`);
        return;
      }

      throw new Error(`Unknown plugins config command: ${subcommand}`);
    }
    case 'doctor':
      await runDoctor(config, args);
      return;
    default:
      throw new Error(`Unknown plugins command: ${action}`);
  }
}

async function runList(config: ReturnType<typeof loadConfigFromEnv>, args: ParsedArgs): Promise<void> {
  const asJson = hasFlag(args.flags, 'json');
  const catalog = await discoverPluginCatalog(config);
  const workspaceState = await loadPluginInstallState(config, 'workspace');
  const globalState = await loadPluginInstallState(config, 'global');

  const items = await Promise.all(catalog.manifests.map(async (manifest) => {
    const validation = manifest.runtimeCapable && manifest.id
      ? await validatePluginConfig(manifest, { ...(config.plugins?.entries?.[manifest.id]?.config ?? {}) })
      : { valid: true, issues: [], schema: null };
    const install = manifest.id
      ? workspaceState.records[manifest.id] ?? globalState.records[manifest.id]
      : undefined;
    const enabled = isPluginEnabled(config, manifest);
    const status = !enabled
      ? 'disabled'
      : !validation.valid
        ? 'unhealthy'
        : 'available';

    return {
      id: manifest.id ?? manifest.name,
      runtimeCapable: manifest.runtimeCapable,
      name: manifest.name,
      version: manifest.version ?? null,
      status,
      enabled,
      scope: manifest.scope,
      sourceKind: manifest.sourceKind,
      path: manifest.rootDir,
      tools: [],
      cliCommands: (manifest.cli?.commands ?? []).map((command) => command.name),
      routeCount: 0,
      lastError: validation.valid ? null : validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      install,
    };
  }));

  if (asJson) {
    console.log(JSON.stringify({
      roots: buildPluginSourceRoots(config),
      plugins: items,
      duplicates: catalog.duplicates,
      commandCollisions: catalog.commandCollisions,
      diagnostics: catalog.diagnostics,
    }, null, 2));
    return;
  }

  if (items.length === 0) {
    console.log('No plugins discovered.');
    return;
  }

  for (const item of items.sort((left, right) => left.id.localeCompare(right.id))) {
    console.log(`- ${item.id}: ${item.status}${item.runtimeCapable ? '' : ' (skills-only)'}`);
  }
}

async function runInfo(config: ReturnType<typeof loadConfigFromEnv>, args: ParsedArgs): Promise<void> {
  const pluginId = args.positional[2]?.trim();
  if (!pluginId) {
    throw new Error('Usage: keygate plugins info <id> [--json]');
  }

  const asJson = hasFlag(args.flags, 'json');
  const catalog = await discoverPluginCatalog(config);
  const manifest = findManifestById(catalog, pluginId);
  if (!manifest) {
    throw new Error(`Unknown plugin: ${pluginId}`);
  }

  const validation = manifest.runtimeCapable
    ? await validatePluginConfig(manifest, { ...(config.plugins?.entries?.[pluginId]?.config ?? {}) })
    : { valid: true, issues: [], schema: null };
  const workspaceState = await loadPluginInstallState(config, 'workspace');
  const globalState = await loadPluginInstallState(config, 'global');
  const install = workspaceState.records[pluginId] ?? globalState.records[pluginId] ?? null;

  const payload = {
    manifest,
    enabled: isPluginEnabled(config, manifest),
    config: config.plugins?.entries?.[pluginId] ?? {},
    configValidation: validation,
    install,
  };

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`id: ${manifest.id ?? manifest.name}`);
  console.log(`name: ${manifest.name}`);
  console.log(`runtime: ${manifest.runtimeCapable ? 'yes' : 'no'}`);
  console.log(`enabled: ${isPluginEnabled(config, manifest) ? 'yes' : 'no'}`);
  console.log(`version: ${manifest.version ?? '(none)'}`);
  console.log(`path: ${manifest.rootDir}`);
  console.log(`commands: ${(manifest.cli?.commands ?? []).map((command) => command.name).join(', ') || '(none)'}`);
  console.log(`skill dirs: ${manifest.skillDirPaths.join(', ') || '(none)'}`);
  if (install) {
    console.log(`install: ${install.scope} from ${install.source}`);
  }
  if (!validation.valid) {
    console.log(`config issues: ${validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
  }
}

async function runDoctor(config: ReturnType<typeof loadConfigFromEnv>, args: ParsedArgs): Promise<void> {
  const asJson = hasFlag(args.flags, 'json');
  const catalog = await discoverPluginCatalog(config);
  const perPlugin = await Promise.all(
    catalog.manifests
      .filter((manifest) => manifest.runtimeCapable && manifest.id)
      .map(async (manifest) => ({
        id: manifest.id!,
        validation: await validatePluginConfig(manifest, { ...(config.plugins?.entries?.[manifest.id!]?.config ?? {}) }),
      }))
  );

  if (asJson) {
    console.log(JSON.stringify({
      roots: catalog.roots,
      duplicates: catalog.duplicates,
      commandCollisions: catalog.commandCollisions,
      diagnostics: catalog.diagnostics,
      validations: perPlugin,
    }, null, 2));
    return;
  }

  console.log(`roots: ${catalog.roots.map((root) => root.path).join(', ') || '(none)'}`);
  if (catalog.duplicates.length > 0) {
    console.log('duplicates:');
    for (const duplicate of catalog.duplicates) {
      console.log(`- ${duplicate.id}: kept=${duplicate.kept} dropped=${duplicate.dropped}`);
    }
  }
  if (catalog.commandCollisions.length > 0) {
    console.log('command collisions:');
    for (const collision of catalog.commandCollisions) {
      console.log(`- ${collision.command}: ${collision.pluginIds.join(', ')}`);
    }
  }
  if (catalog.diagnostics.length > 0) {
    console.log('diagnostics:');
    for (const diagnostic of catalog.diagnostics) {
      console.log(`- ${diagnostic.location}: ${diagnostic.error}`);
    }
  }
  for (const entry of perPlugin) {
    if (!entry.validation.valid) {
      console.log(`- ${entry.id}: invalid config (${entry.validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')})`);
    }
  }
}

async function assertPluginLoads(config: ReturnType<typeof loadConfigFromEnv>, pluginId: string): Promise<void> {
  const catalog = await discoverPluginCatalog(config);
  const manifest = findManifestById(catalog, pluginId);
  if (!manifest || !manifest.runtimeCapable) {
    throw new Error(`Unknown runtime plugin: ${pluginId}`);
  }
  const validation = await validatePluginConfig(manifest, { ...(config.plugins?.entries?.[pluginId]?.config ?? {}) });
  if (!validation.valid) {
    throw new Error(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
  }
}

function normalizeScope(value: string): PluginScope {
  return value === 'global' ? 'global' : 'workspace';
}

async function persistPluginEnabled(pluginId: string, enabled: boolean, purge = false): Promise<void> {
  await savePersistedConfigObject((root) => {
    const nextRoot = { ...root };
    const plugins = nextRoot['plugins'] && typeof nextRoot['plugins'] === 'object' && !Array.isArray(nextRoot['plugins'])
      ? { ...(nextRoot['plugins'] as Record<string, unknown>) }
      : {};
    const entries = plugins['entries'] && typeof plugins['entries'] === 'object' && !Array.isArray(plugins['entries'])
      ? { ...(plugins['entries'] as Record<string, unknown>) }
      : {};

    if (purge) {
      delete entries[pluginId];
    } else {
      const current = entries[pluginId] && typeof entries[pluginId] === 'object' && !Array.isArray(entries[pluginId])
        ? { ...(entries[pluginId] as Record<string, unknown>) }
        : {};
      current['enabled'] = enabled;
      entries[pluginId] = current;
    }

    plugins['entries'] = entries;
    nextRoot['plugins'] = plugins;
    return nextRoot;
  });
}

async function persistPluginConfig(pluginId: string, configValue: Record<string, unknown>): Promise<void> {
  await savePersistedConfigObject((root) => {
    const nextRoot = { ...root };
    const plugins = nextRoot['plugins'] && typeof nextRoot['plugins'] === 'object' && !Array.isArray(nextRoot['plugins'])
      ? { ...(nextRoot['plugins'] as Record<string, unknown>) }
      : {};
    const entries = plugins['entries'] && typeof plugins['entries'] === 'object' && !Array.isArray(plugins['entries'])
      ? { ...(plugins['entries'] as Record<string, unknown>) }
      : {};
    const current = entries[pluginId] && typeof entries[pluginId] === 'object' && !Array.isArray(entries[pluginId])
      ? { ...(entries[pluginId] as Record<string, unknown>) }
      : {};
    current['config'] = configValue;
    current['enabled'] = current['enabled'] === false ? false : true;
    entries[pluginId] = current;
    plugins['entries'] = entries;
    nextRoot['plugins'] = plugins;
    return nextRoot;
  });
}

function printPluginSummary(info: {
  manifest: ResolvedPluginManifest;
  status: string;
  tools: string[];
  cliCommands: string[];
  httpRoutes: Array<{ method: string; path: string }>;
  lastError: string | null;
}): void {
  console.log(`plugin: ${info.manifest.id}`);
  console.log(`status: ${info.status}`);
  console.log(`tools: ${info.tools.join(', ') || '(none)'}`);
  console.log(`commands: ${info.cliCommands.join(', ') || '(none)'}`);
  console.log(`routes: ${info.httpRoutes.map((route) => `${route.method} /api/plugins/${info.manifest.id}/${route.path}`).join(', ') || '(none)'}`);
  if (info.lastError) {
    console.log(`last error: ${info.lastError}`);
  }
}
