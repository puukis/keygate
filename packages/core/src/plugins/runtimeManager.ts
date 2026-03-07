import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { savePersistedConfigObject } from '../config/env.js';
import type { Gateway } from '../gateway/Gateway.js';
import type { KeygateEvents } from '../types.js';
import {
  buildBuiltinCommandSet,
  discoverPluginCatalog,
  findManifestById,
  isPluginEnabled,
} from './catalog.js';
import { createPluginEventsApi } from './events.js';
import {
  installPluginFromSource,
  loadPluginInstallState,
  removeInstalledPlugin,
  updateInstalledPlugin,
} from './installer.js';
import { PluginHttpRegistry } from './httpRegistry.js';
import { PluginRegistries } from './registries.js';
import { validatePluginConfig } from './schema.js';
import type {
  ActivePluginState,
  KeygateRuntimePlugin,
  PluginCatalogSnapshot,
  PluginCliCommandDefinition,
  PluginDiagnostic,
  PluginHookName,
  PluginHttpRequestContext,
  PluginHttpResult,
  PluginInfo,
  PluginInstallRequest,
  PluginListItem,
  PluginStage,
  PluginStatus,
  ResolvedPluginManifest,
} from './types.js';

interface RuntimePluginInstance {
  manifest: ResolvedPluginManifest;
  stage: PluginStage;
  startedServices: string[];
  configSchema: Record<string, unknown> | null;
  lastError: string | null;
  watchers: FSWatcher[];
}

function createEmptyStage(): PluginStage {
  return {
    tools: [],
    toolNames: [],
    hooks: [],
    rpcMethods: new Map(),
    httpRoutes: [],
    cliCommands: [],
    services: [],
    eventSubscriptions: [],
  };
}

export class PluginRuntimeManager {
  private catalog: PluginCatalogSnapshot | null = null;
  private readonly registries = new PluginRegistries();
  private readonly httpRegistry = new PluginHttpRegistry();
  private readonly active = new Map<string, RuntimePluginInstance>();
  private readonly failed = new Map<string, { manifest: ResolvedPluginManifest; error: string; configSchema: Record<string, unknown> | null }>();
  private readonly reloadTimers = new Map<string, NodeJS.Timeout>();
  private readonly hookFailures: Array<{ pluginId: string; hook: PluginHookName; error: string; at: string }> = [];
  private refreshPromise: Promise<void> | null = null;

  constructor(private readonly gateway: Gateway) {}

  async start(): Promise<void> {
    await this.refresh();
  }

  stop(): void {
    for (const timer of this.reloadTimers.values()) {
      clearTimeout(timer);
    }
    this.reloadTimers.clear();

    for (const pluginId of Array.from(this.active.keys())) {
      void this.deactivatePlugin(pluginId);
    }
  }

  getHttpRegistry(): PluginHttpRegistry {
    return this.httpRegistry;
  }

  getRegistries(): PluginRegistries {
    return this.registries;
  }

  getHookFailures(): Array<{ pluginId: string; hook: PluginHookName; error: string; at: string }> {
    return [...this.hookFailures];
  }

  async runHook<TPayload extends Record<string, unknown>>(name: PluginHookName, payload: TPayload): Promise<TPayload> {
    const hooks = this.collectHooks(name);
    let current = payload;

    for (const hook of hooks) {
      try {
        const result = await hook.handler(current);
        if (result && typeof result === 'object' && !Array.isArray(result) && isMutatingHook(name)) {
          current = {
            ...current,
            ...result,
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.hookFailures.push({
          pluginId: hook.pluginId,
          hook: name,
          error: message,
          at: new Date().toISOString(),
        });
      }
    }

    while (this.hookFailures.length > 200) {
      this.hookFailures.shift();
    }

    return current;
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refreshInternal();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async listPlugins(): Promise<PluginListItem[]> {
    if (!this.catalog) {
      this.catalog = await discoverPluginCatalog(this.gateway.config);
    }

    const items: PluginListItem[] = [];
    const installStates = await Promise.all([
      loadPluginInstallState(this.gateway.config, 'workspace'),
      loadPluginInstallState(this.gateway.config, 'global'),
    ]);

    const installById = new Map<string, PluginListItem['install']>();
    for (const state of installStates) {
      for (const record of Object.values(state.records)) {
        installById.set(record.id, record);
      }
    }

    const diagnosticsByManifest = new Map<string, PluginDiagnostic[]>();
    for (const diagnostic of this.catalog.diagnostics) {
      const entries = diagnosticsByManifest.get(path.resolve(diagnostic.location)) ?? [];
      entries.push(diagnostic);
      diagnosticsByManifest.set(path.resolve(diagnostic.location), entries);
    }

    for (const manifest of this.catalog.manifests) {
      const state = manifest.id ? this.active.get(manifest.id) : undefined;
      const failed = manifest.id ? this.failed.get(manifest.id) : undefined;
      const enabled = isPluginEnabled(this.gateway.config, manifest);
      const lastError = state?.lastError ?? failed?.error ?? null;
      const publicState = state
        ? this.buildPublicState(state, 'active')
        : failed
          ? this.buildFailedPublicState(failed.manifest, failed.configSchema, failed.error)
          : this.buildAvailablePublicState(manifest, enabled ? 'available' : 'disabled');

      items.push({
        ...publicState,
        enabled,
        sourceKind: manifest.sourceKind,
        scope: manifest.scope,
        version: manifest.version ?? null,
        description: manifest.description ?? null,
        diagnostics: diagnosticsByManifest.get(path.resolve(manifest.manifestPath)) ?? [],
        install: manifest.id ? installById.get(manifest.id) : undefined,
        lastError,
      });
    }

    for (const [pluginId, failed] of this.failed) {
      if (items.some((item) => item.manifest.id === pluginId)) {
        continue;
      }
      items.push({
        ...this.buildFailedPublicState(failed.manifest, failed.configSchema, failed.error),
        enabled: isPluginEnabled(this.gateway.config, failed.manifest),
        sourceKind: failed.manifest.sourceKind,
        scope: failed.manifest.scope,
        version: failed.manifest.version ?? null,
        description: failed.manifest.description ?? null,
        diagnostics: [],
      });
    }

    return items.sort((left, right) => (
      (left.manifest.id ?? left.manifest.name).localeCompare(right.manifest.id ?? right.manifest.name)
    ));
  }

  async getPluginInfo(pluginId: string): Promise<PluginInfo> {
    const items = await this.listPlugins();
    const match = items.find((item) => item.manifest.id === pluginId);
    if (!match) {
      throw new Error(`Unknown plugin: ${pluginId}`);
    }

    const config = { ...(this.gateway.config.plugins?.entries?.[pluginId]?.config ?? {}) };
    const validation = match.manifest.runtimeCapable
      ? await validatePluginConfig(match.manifest, config)
      : { schema: null };

    return {
      ...match,
      configSchema: validation.schema ?? match.configSchema,
      manifestJson: {
        schemaVersion: match.manifest.schemaVersion,
        id: match.manifest.id,
        name: match.manifest.name,
        version: match.manifest.version,
        description: match.manifest.description,
        entry: match.manifest.entry,
        engine: match.manifest.engine,
        skillsDirs: match.manifest.skillsDirs,
        configSchema: match.manifest.configSchema,
        cli: match.manifest.cli,
      },
      config,
      env: { ...(this.gateway.config.plugins?.entries?.[pluginId]?.env ?? {}) },
    };
  }

  async installPlugin(request: Omit<PluginInstallRequest, 'nodeManager'>): Promise<PluginInfo> {
    const installResult = await installPluginFromSource(this.gateway.config, {
      ...request,
      nodeManager: this.gateway.config.plugins?.install.nodeManager ?? 'npm',
    });
    const pluginId = installResult.manifest.id;
    if (!pluginId) {
      throw new Error('Installed plugin is missing a runtime plugin id.');
    }

    await this.persistPluginEntry(pluginId, (entry) => ({
      ...entry,
      enabled: true,
    }));

    await this.refresh();
    return this.getPluginInfo(pluginId);
  }

  async updatePlugin(pluginId?: string): Promise<PluginInfo[]> {
    if (!pluginId) {
      const items = await this.listPlugins();
      const installed = items.filter((item) => item.install);
      const updated: PluginInfo[] = [];
      for (const item of installed) {
        if (!item.manifest.id) {
          continue;
        }
        updated.push(...await this.updatePlugin(item.manifest.id));
      }
      return updated;
    }

    await updateInstalledPlugin(this.gateway.config, pluginId);
    await this.refresh();
    return [await this.getPluginInfo(pluginId)];
  }

  async removePlugin(pluginId: string, purge = false): Promise<boolean> {
    await this.deactivatePlugin(pluginId);
    this.failed.delete(pluginId);
    const removed = await removeInstalledPlugin(this.gateway.config, pluginId);
    if (!removed) {
      return false;
    }

    if (purge) {
      await this.persistPluginEntry(pluginId, () => undefined);
    } else {
      await this.persistPluginEntry(pluginId, (entry) => ({
        ...entry,
        enabled: false,
      }));
    }

    this.catalog = await discoverPluginCatalog(this.gateway.config);
    return true;
  }

  async enablePlugin(pluginId: string): Promise<PluginInfo> {
    await this.persistPluginEntry(pluginId, (entry) => ({
      ...entry,
      enabled: true,
    }));
    await this.refresh();
    return this.getPluginInfo(pluginId);
  }

  async disablePlugin(pluginId: string): Promise<PluginInfo> {
    await this.persistPluginEntry(pluginId, (entry) => ({
      ...entry,
      enabled: false,
    }));
    await this.deactivatePlugin(pluginId);
    await this.refresh();
    return this.getPluginInfo(pluginId);
  }

  async reloadPlugin(pluginId?: string): Promise<PluginInfo[]> {
    if (!pluginId) {
      const targets = (this.catalog?.manifests ?? []).filter((manifest) => manifest.runtimeCapable && manifest.id);
      const reloaded: PluginInfo[] = [];
      for (const target of targets) {
        reloaded.push(...await this.reloadPlugin(target.id!));
      }
      return reloaded;
    }

    const manifest = await this.resolveRuntimeManifest(pluginId);
    await this.activatePlugin(manifest, true);
    return [await this.getPluginInfo(pluginId)];
  }

  async setPluginConfig(pluginId: string, configValue: Record<string, unknown>): Promise<PluginInfo> {
    const manifest = await this.resolveRuntimeManifest(pluginId);
    const validation = await validatePluginConfig(manifest, configValue);
    if (!validation.valid) {
      const detail = validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
      throw new Error(detail || 'Plugin config validation failed.');
    }

    await this.persistPluginEntry(pluginId, (entry) => ({
      ...entry,
      config: { ...configValue },
    }));

    if (this.active.has(pluginId)) {
      await this.activatePlugin(manifest, true);
    }

    return this.getPluginInfo(pluginId);
  }

  async validatePlugin(pluginId: string) {
    const manifest = await this.resolveRuntimeManifest(pluginId);
    const entry = this.gateway.config.plugins?.entries?.[pluginId];
    return validatePluginConfig(manifest, { ...(entry?.config ?? {}) });
  }

  async invokeRpc(pluginId: string, method: string, params: unknown): Promise<unknown> {
    const handler = this.registries.getRpcHandler(pluginId, method);
    if (!handler) {
      throw new Error(`Unknown plugin RPC method: ${pluginId}.${method}`);
    }
    return handler(params);
  }

  async handleHttpRoute(
    pluginId: string,
    method: string,
    subPath: string,
    context: PluginHttpRequestContext
  ): Promise<PluginHttpResult | null> {
    const route = this.httpRegistry.resolve(pluginId, method, subPath);
    if (!route) {
      return null;
    }

    if (route.auth === 'operator') {
      const expected = this.gateway.config.server.apiToken.trim();
      if (!expected) {
        throw new Error('Plugin operator routes require server.apiToken to be configured.');
      }

      const header = context.headers['authorization'] ?? '';
      const received = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
      if (received !== expected) {
        return {
          status: 401,
          json: {
            error: 'Unauthorized',
          },
        };
      }
    }

    return route.handler(context);
  }

  async runCliCommand(commandName: string, argv: import('../cli/argv.js').ParsedArgs): Promise<boolean> {
    const command = this.registries.getCliCommand(commandName);
    if (!command) {
      return false;
    }

    await command.definition.run({
      argv,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    return true;
  }

  private collectHooks(name: PluginHookName): Array<{
    pluginId: string;
    handler: NonNullable<PluginStage['hooks']>[number]['handler'];
    priority: number;
  }> {
    return Array.from(this.active.entries())
      .flatMap(([pluginId, instance]) => (
        instance.stage.hooks
          .filter((hook) => hook.name === name)
          .map((hook) => ({
            pluginId,
            handler: hook.handler,
            priority: hook.priority,
          }))
      ))
      .sort((left, right) => {
        if (left.priority !== right.priority) {
          return right.priority - left.priority;
        }
        return left.pluginId.localeCompare(right.pluginId);
      });
  }

  private async refreshInternal(): Promise<void> {
    this.catalog = await discoverPluginCatalog(this.gateway.config);
    const runtimeManifests = this.catalog.manifests.filter((manifest) => manifest.runtimeCapable && manifest.id);
    const desiredIds = new Set(
      runtimeManifests
        .filter((manifest) => isPluginEnabled(this.gateway.config, manifest))
        .map((manifest) => manifest.id!)
    );

    for (const pluginId of Array.from(this.active.keys())) {
      if (!desiredIds.has(pluginId)) {
        await this.deactivatePlugin(pluginId);
      }
    }

    for (const manifest of runtimeManifests) {
      if (!isPluginEnabled(this.gateway.config, manifest)) {
        continue;
      }

      const current = this.active.get(manifest.id!);
      if (!current) {
        await this.activatePlugin(manifest, false);
        continue;
      }

      if (current.manifest.manifestPath !== manifest.manifestPath || current.manifest.version !== manifest.version) {
        await this.activatePlugin(manifest, true);
      }
    }
  }

  private async activatePlugin(manifest: ResolvedPluginManifest, replacing: boolean): Promise<void> {
    const pluginId = manifest.id!;

    try {
      this.assertManifestIsActivatable(manifest);
      const configResult = await validatePluginConfig(manifest, {
        ...(this.gateway.config.plugins?.entries?.[pluginId]?.config ?? {}),
      });

      if (!configResult.valid) {
        const message = configResult.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
        throw new Error(message || 'Plugin config validation failed.');
      }

      const stage = createEmptyStage();
      const plugin = await this.importPluginModule(manifest);
      const logger = createPluginLogger(pluginId);

      const api = {
        pluginId,
        manifest,
        pluginConfig: { ...(this.gateway.config.plugins?.entries?.[pluginId]?.config ?? {}) },
        env: { ...(this.gateway.config.plugins?.entries?.[pluginId]?.env ?? {}) },
        coreConfig: this.gateway.config,
        logger,
        paths: {
          root: manifest.rootDir,
          manifest: manifest.manifestPath,
          entry: manifest.entryPath,
          configSchema: manifest.configSchemaPath,
        },
        events: createPluginEventsApi(this.gateway, stage),
        sendMessageToSession: async (sessionId: string, content: string, source?: string) => {
          await this.gateway.sendMessageToSession(sessionId, content, source ?? `plugin:${pluginId}`);
        },
        listSessions: () => this.gateway.listSessions().map((session) => ({
          id: session.id,
          channelType: session.channelType,
          title: session.title,
          updatedAt: session.updatedAt.toISOString(),
        })),
        getSessionHistory: (sessionId: string, limit = 50) => (
          this.gateway.getSessionHistory(sessionId, limit).map((message) => ({
            role: message.role,
            content: message.content,
          }))
        ),
        registerHook: (name, handler, options) => {
          stage.hooks.push({
            name,
            priority: typeof options?.priority === 'number' ? options.priority : 0,
            handler,
          });
        },
        registerTool: (definition: import('./types.js').PluginToolDefinition) => {
          const fullName = `${pluginId}.${definition.name}`;
          stage.tools.push({
            ...definition,
            name: fullName,
          });
          stage.toolNames.push(fullName);
        },
        registerRpcMethod: (name: string, handler: (params: unknown) => Promise<unknown> | unknown) => {
          const normalized = name.trim();
          if (!normalized) {
            throw new Error('Plugin RPC method names must be non-empty.');
          }
          stage.rpcMethods.set(normalized, handler);
        },
        registerHttpRoute: (definition: import('./types.js').PluginHttpRouteDefinition) => {
          stage.httpRoutes.push({
            ...definition,
            method: definition.method.toUpperCase() as import('./types.js').PluginHttpMethod,
            path: normalizeRoutePath(definition.path),
          });
        },
        registerCliCommand: (definition: PluginCliCommandDefinition) => {
          stage.cliCommands.push({
            ...definition,
            name: definition.name.trim(),
          });
        },
        registerService: (definition: import('./types.js').PluginServiceDefinition) => {
          stage.services.push({
            ...definition,
            id: definition.id.trim(),
          });
        },
      } satisfies import('./types.js').PluginSetupApi;

      await plugin.setup(api);
      this.validateStageAgainstManifest(manifest, stage);
      this.assertOperatorRouteConfig(stage);
      await this.startStagedServices(stage);
      const previous = this.active.get(pluginId);
      if (previous) {
        await this.teardownInstance(previous);
      }

      for (const tool of stage.tools) {
        this.gateway.toolExecutor.registerTool(tool, pluginId);
      }
      this.registries.replacePlugin(pluginId, {
        rpcMethods: stage.rpcMethods,
        httpRoutes: stage.httpRoutes,
        cliCommands: stage.cliCommands,
      });
      this.httpRegistry.replacePlugin(pluginId, stage.httpRoutes);

      const watchers = this.gateway.config.plugins?.load.watch === false
        ? []
        : this.setupWatchers(manifest);

      this.active.set(pluginId, {
        manifest,
        stage,
        startedServices: stage.services.map((service) => `${pluginId}.${service.id}`),
        configSchema: configResult.schema,
        lastError: null,
        watchers,
      });
      this.failed.delete(pluginId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const existing = this.active.get(pluginId);
      if (replacing && existing) {
        existing.lastError = errorMessage;
        return;
      }
      const configResult = await validatePluginConfig(manifest, {
        ...(this.gateway.config.plugins?.entries?.[pluginId]?.config ?? {}),
      }).catch(() => ({ schema: null }));

      this.failed.set(pluginId, {
        manifest,
        error: errorMessage,
        configSchema: configResult.schema ?? null,
      });

      if (!replacing) {
        await this.deactivatePlugin(pluginId);
      }
    }
  }

  private async deactivatePlugin(pluginId: string): Promise<void> {
    const instance = this.active.get(pluginId);
    if (!instance) {
      this.registries.removePlugin(pluginId);
      this.httpRegistry.removePlugin(pluginId);
      return;
    }

    await this.teardownInstance(instance);
    this.active.delete(pluginId);
    this.registries.removePlugin(pluginId);
    this.httpRegistry.removePlugin(pluginId);
  }

  private async teardownInstance(instance: RuntimePluginInstance): Promise<void> {
    for (const watcher of instance.watchers) {
      watcher.close();
    }

    for (let index = instance.stage.services.length - 1; index >= 0; index -= 1) {
      const service = instance.stage.services[index]!;
      if (!service.stop) {
        continue;
      }
      await Promise.race([
        Promise.resolve(service.stop()),
        new Promise<void>((resolve) => {
          setTimeout(resolve, 5_000);
        }),
      ]);
    }

    for (const fullName of instance.stage.toolNames) {
      this.gateway.toolExecutor.unregisterTool(fullName);
    }

    for (const subscription of instance.stage.eventSubscriptions) {
      this.gateway.off(
        subscription.eventName as keyof KeygateEvents,
        subscription.listener as never
      );
    }
  }

  private setupWatchers(manifest: ResolvedPluginManifest): FSWatcher[] {
    const watchers: FSWatcher[] = [];
    try {
      const watcher = watch(manifest.rootDir, { recursive: true }, () => {
        const existing = this.reloadTimers.get(manifest.id!);
        if (existing) {
          clearTimeout(existing);
        }
        const timer = setTimeout(() => {
          void this.reloadPlugin(manifest.id!).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.failed.set(manifest.id!, {
              manifest,
              error: message,
              configSchema: this.active.get(manifest.id!)?.configSchema ?? null,
            });
          });
        }, this.gateway.config.plugins?.load.watchDebounceMs ?? 250);
        this.reloadTimers.set(manifest.id!, timer);
      });
      watchers.push(watcher);
    } catch {
      // Recursive watch is not available everywhere; plugin hot reload degrades gracefully.
    }
    return watchers;
  }

  private async importPluginModule(manifest: ResolvedPluginManifest): Promise<KeygateRuntimePlugin> {
    const moduleUrl = `${pathToFileURL(manifest.entryPath!).href}?v=${Date.now()}`;
    const imported = await import(moduleUrl);
    const candidate = (imported.default ?? imported.plugin ?? imported) as Partial<KeygateRuntimePlugin>;
    if (!candidate || typeof candidate.setup !== 'function') {
      throw new Error('Plugin entry module must export an object with an async setup(api) function.');
    }
    return candidate as KeygateRuntimePlugin;
  }

  private validateStageAgainstManifest(manifest: ResolvedPluginManifest, stage: PluginStage): void {
    const reserved = new Set((manifest.cli?.commands ?? []).map((command) => command.name));
    const registered = new Set(stage.cliCommands.map((command) => command.name));

    if (reserved.size !== registered.size) {
      throw new Error('Plugin CLI command registrations must exactly match manifest.cli.commands.');
    }

    for (const command of reserved) {
      if (!registered.has(command)) {
        throw new Error(`Plugin CLI command "${command}" is declared in the manifest but was not registered.`);
      }
    }

    for (const command of registered) {
      if (!reserved.has(command)) {
        throw new Error(`Plugin CLI command "${command}" must be predeclared in manifest.cli.commands.`);
      }
    }
  }

  private assertManifestIsActivatable(manifest: ResolvedPluginManifest): void {
    const builtins = buildBuiltinCommandSet();
    for (const command of manifest.cli?.commands ?? []) {
      if (builtins.has(command.name)) {
        throw new Error(`Plugin CLI command "${command.name}" conflicts with a built-in command.`);
      }
    }

    const collisions = this.catalog?.commandCollisions.filter((entry) => entry.pluginIds.includes(manifest.id!)) ?? [];
    if (collisions.length > 0) {
      const detail = collisions.map((entry) => entry.command).join(', ');
      throw new Error(`Plugin CLI command collision detected: ${detail}`);
    }
  }

  private assertOperatorRouteConfig(stage: PluginStage): void {
    const needsAuth = stage.httpRoutes.some((route) => route.auth === 'operator');
    if (needsAuth && !this.gateway.config.server.apiToken.trim()) {
      throw new Error('Plugin operator routes require server.apiToken to be configured.');
    }
  }

  private async startStagedServices(stage: PluginStage): Promise<void> {
    const started: Array<() => Promise<void> | void> = [];
    try {
      for (const service of stage.services) {
        if (!service.start) {
          continue;
        }
        await service.start();
        if (service.stop) {
          started.push(service.stop);
        }
      }
    } catch (error) {
      for (let index = started.length - 1; index >= 0; index -= 1) {
        await Promise.resolve(started[index]!()).catch(() => undefined);
      }
      throw error;
    }
  }

  private async resolveRuntimeManifest(pluginId: string): Promise<ResolvedPluginManifest> {
    if (!this.catalog) {
      this.catalog = await discoverPluginCatalog(this.gateway.config);
    }
    const manifest = findManifestById(this.catalog, pluginId);
    if (!manifest || !manifest.runtimeCapable) {
      throw new Error(`Unknown runtime plugin: ${pluginId}`);
    }
    return manifest;
  }

  private async persistPluginEntry(
    pluginId: string,
    mutator: (
      current: NonNullable<typeof this.gateway.config.plugins>['entries'][string] | undefined
    ) => NonNullable<typeof this.gateway.config.plugins>['entries'][string] | undefined
  ): Promise<void> {
    const current = this.gateway.config.plugins?.entries?.[pluginId];
    const nextEntry = mutator(current);

    await savePersistedConfigObject((root) => {
      const nextRoot = { ...root };
      const existingPlugins = nextRoot['plugins'] && typeof nextRoot['plugins'] === 'object' && !Array.isArray(nextRoot['plugins'])
        ? { ...(nextRoot['plugins'] as Record<string, unknown>) }
        : {};
      const existingEntries = existingPlugins['entries'] && typeof existingPlugins['entries'] === 'object' && !Array.isArray(existingPlugins['entries'])
        ? { ...(existingPlugins['entries'] as Record<string, unknown>) }
        : {};

      if (nextEntry) {
        existingEntries[pluginId] = nextEntry;
      } else {
        delete existingEntries[pluginId];
      }

      existingPlugins['entries'] = existingEntries;
      if (!existingPlugins['load']) {
        existingPlugins['load'] = {
          watch: this.gateway.config.plugins?.load.watch ?? true,
          watchDebounceMs: this.gateway.config.plugins?.load.watchDebounceMs ?? 250,
          paths: [...(this.gateway.config.plugins?.load.paths ?? [])],
        };
      }
      if (!existingPlugins['install']) {
        existingPlugins['install'] = {
          nodeManager: this.gateway.config.plugins?.install.nodeManager ?? 'npm',
        };
      }

      nextRoot['plugins'] = existingPlugins;
      return nextRoot;
    });

    if (!this.gateway.config.plugins) {
      this.gateway.config.plugins = {
        load: {
          watch: true,
          watchDebounceMs: 250,
          paths: [],
        },
        entries: {},
        install: {
          nodeManager: 'npm',
        },
      };
    }

    if (nextEntry) {
      this.gateway.config.plugins.entries[pluginId] = nextEntry;
    } else {
      delete this.gateway.config.plugins.entries[pluginId];
    }
  }

  private buildPublicState(instance: RuntimePluginInstance, status: PluginStatus): ActivePluginState {
    return {
      manifest: instance.manifest,
      status,
      lastError: instance.lastError,
      tools: [...instance.stage.toolNames],
      rpcMethods: Array.from(instance.stage.rpcMethods.keys()).sort(),
      httpRoutes: instance.stage.httpRoutes.map((route) => ({
        method: route.method,
        path: route.path,
        auth: route.auth,
      })),
      cliCommands: instance.stage.cliCommands.map((command) => command.name).sort(),
      serviceIds: instance.stage.services.map((service) => `${instance.manifest.id}.${service.id}`),
      configSchema: instance.configSchema,
    };
  }

  private buildAvailablePublicState(
    manifest: ResolvedPluginManifest,
    status: PluginStatus
  ): ActivePluginState {
    return {
      manifest,
      status,
      lastError: null,
      tools: [],
      rpcMethods: [],
      httpRoutes: [],
      cliCommands: (manifest.cli?.commands ?? []).map((command) => command.name).sort(),
      serviceIds: [],
      configSchema: null,
    };
  }

  private buildFailedPublicState(
    manifest: ResolvedPluginManifest,
    configSchema: Record<string, unknown> | null,
    error: string
  ): ActivePluginState {
    return {
      manifest,
      status: 'unhealthy',
      lastError: error,
      tools: [],
      rpcMethods: [],
      httpRoutes: [],
      cliCommands: (manifest.cli?.commands ?? []).map((command) => command.name).sort(),
      serviceIds: [],
      configSchema,
    };
  }
}

function createPluginLogger(pluginId: string) {
  const prefix = `[plugin:${pluginId}]`;
  return {
    info(message: string, meta?: Record<string, unknown>) {
      console.info(prefix, message, meta ?? '');
    },
    warn(message: string, meta?: Record<string, unknown>) {
      console.warn(prefix, message, meta ?? '');
    },
    error(message: string, meta?: Record<string, unknown>) {
      console.error(prefix, message, meta ?? '');
    },
    debug(message: string, meta?: Record<string, unknown>) {
      console.debug(prefix, message, meta ?? '');
    },
  };
}

function isMutatingHook(name: PluginHookName): boolean {
  return name === 'before_model_resolve'
    || name === 'before_prompt_build'
    || name === 'message_received'
    || name === 'before_tool_call'
    || name === 'before_compaction';
}

function normalizeRoutePath(value: string): string {
  const trimmed = value.trim().replace(/^\/+/, '').replace(/\/+$/g, '');
  return trimmed || '';
}
