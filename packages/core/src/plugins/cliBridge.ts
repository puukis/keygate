import { pathToFileURL } from 'node:url';
import { KeygateDatabase } from '../db/index.js';
import type { KeygateConfig } from '../types.js';
import type { ParsedArgs } from '../cli/argv.js';
import { buildBuiltinCommandSet, discoverPluginCatalog } from './catalog.js';
import { validatePluginConfig } from './schema.js';
import type { PluginCliCommandDefinition, PluginSetupApi, PluginStage, ResolvedPluginManifest } from './types.js';

export async function runPluginCliBridge(
  config: KeygateConfig,
  argv: ParsedArgs
): Promise<boolean> {
  const commandName = argv.positional[0]?.trim();
  if (!commandName) {
    return false;
  }

  if (buildBuiltinCommandSet().has(commandName)) {
    return false;
  }

  const catalog = await discoverPluginCatalog(config);
  const owner = catalog.manifests.find((manifest) => (
    manifest.runtimeCapable
    && manifest.id
    && manifest.enabled
    && config.plugins?.entries?.[manifest.id]?.enabled !== false
    && (manifest.cli?.commands ?? []).some((command) => command.name === commandName)
  ));

  if (!owner) {
    return false;
  }

  if (catalog.commandCollisions.some((entry) => entry.command === commandName)) {
    throw new Error(`Plugin CLI command collision detected: ${commandName}`);
  }

  await executePluginCliCommand(config, owner, commandName, argv);
  return true;
}

async function executePluginCliCommand(
  config: KeygateConfig,
  manifest: ResolvedPluginManifest,
  commandName: string,
  argv: ParsedArgs
): Promise<void> {
  const configResult = await validatePluginConfig(manifest, {
    ...(config.plugins?.entries?.[manifest.id!]?.config ?? {}),
  });
  if (!configResult.valid) {
    const message = configResult.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    throw new Error(message || 'Plugin config validation failed.');
  }

  const stage: PluginStage = {
    tools: [],
    toolNames: [],
    rpcMethods: new Map(),
    httpRoutes: [],
    cliCommands: [],
    services: [],
    eventSubscriptions: [],
  };

  const db = new KeygateDatabase();
  const moduleUrl = `${pathToFileURL(manifest.entryPath!).href}?cli=${Date.now()}`;
  const imported = await import(moduleUrl);
  const plugin = (imported.default ?? imported.plugin ?? imported) as { setup?: (api: PluginSetupApi) => Promise<void> | void };
  if (!plugin || typeof plugin.setup !== 'function') {
    throw new Error('Plugin entry module must export an object with setup(api).');
  }

  const api = {
    pluginId: manifest.id!,
    manifest,
    pluginConfig: { ...(config.plugins?.entries?.[manifest.id!]?.config ?? {}) },
    env: { ...(config.plugins?.entries?.[manifest.id!]?.env ?? {}) },
    coreConfig: config,
    logger: createCliLogger(manifest.id!),
    paths: {
      root: manifest.rootDir,
      manifest: manifest.manifestPath,
      entry: manifest.entryPath,
      configSchema: manifest.configSchemaPath,
    },
    events: {
      on() {
        throw new Error('Plugin event subscriptions are not available in CLI-only mode.');
      },
    },
    async sendMessageToSession() {
      throw new Error('Sending messages is not available in CLI-only mode.');
    },
    listSessions: () => db.listSessions().map((session) => ({
      id: session.id,
      channelType: session.channelType,
      title: session.title,
      updatedAt: session.updatedAt.toISOString(),
    })),
    getSessionHistory: (sessionId: string, limit = 50) => (
      (db.getSession(sessionId)?.messages ?? []).slice(-Math.max(1, limit)).map((message) => ({
        role: message.role,
        content: message.content,
      }))
    ),
    registerTool(definition) {
      stage.tools.push({
        ...definition,
        name: `${manifest.id}.${definition.name}`,
      });
      stage.toolNames.push(`${manifest.id}.${definition.name}`);
    },
    registerRpcMethod(name, handler) {
      stage.rpcMethods.set(name, handler);
    },
    registerHttpRoute(definition) {
      stage.httpRoutes.push({
        ...definition,
        path: definition.path.trim().replace(/^\/+/, '').replace(/\/+$/g, ''),
      });
    },
    registerCliCommand(definition: PluginCliCommandDefinition) {
      stage.cliCommands.push({
        ...definition,
        name: definition.name.trim(),
      });
    },
    registerService(definition) {
      stage.services.push({
        ...definition,
        id: definition.id.trim(),
      });
    },
  } satisfies PluginSetupApi;

  await plugin.setup(api);

  const reserved = new Set((manifest.cli?.commands ?? []).map((command) => command.name));
  const registered = new Set(stage.cliCommands.map((command) => command.name));
  if (reserved.size !== registered.size || !reserved.has(commandName) || !registered.has(commandName)) {
    throw new Error('Plugin CLI command registrations must exactly match manifest.cli.commands.');
  }

  const command = stage.cliCommands.find((entry) => entry.name === commandName);
  if (!command) {
    throw new Error(`Plugin did not register the "${commandName}" CLI command.`);
  }

  await command.run({
    argv,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

function createCliLogger(pluginId: string) {
  const prefix = `[plugin:${pluginId}]`;
  return {
    info(message: string) {
      console.log(prefix, message);
    },
    warn(message: string) {
      console.warn(prefix, message);
    },
    error(message: string) {
      console.error(prefix, message);
    },
    debug(message: string) {
      console.debug(prefix, message);
    },
  };
}
