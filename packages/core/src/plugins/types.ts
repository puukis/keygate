import type { IncomingMessage } from 'node:http';
import type {
  KeygateConfig,
  KeygateEvents,
  NodeManager,
  Tool,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '../types.js';
import type { ParsedArgs } from '../cli/argv.js';

export type PluginScope = 'workspace' | 'global';
export type PluginSourceKind = 'explicit' | 'legacy' | 'workspace' | 'global';
export type PluginStatus = 'active' | 'disabled' | 'unhealthy' | 'available';
export type PluginHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type PluginHttpAuth = 'public' | 'operator';
export type PluginHookName =
  | 'before_model_resolve'
  | 'before_prompt_build'
  | 'message_received'
  | 'message_sent'
  | 'before_tool_call'
  | 'after_tool_call'
  | 'before_compaction'
  | 'after_compaction'
  | 'session_start'
  | 'session_end'
  | 'subagent_spawning'
  | 'subagent_spawned'
  | 'subagent_ended'
  | 'gateway_start'
  | 'gateway_stop';

export type PluginHookHandler<TPayload = unknown> =
  (payload: TPayload) => Promise<Partial<TPayload> | void> | Partial<TPayload> | void;

export interface PluginManifestCommandReservation {
  name: string;
  summary?: string;
}

export interface PluginManifestCli {
  commands?: PluginManifestCommandReservation[];
}

export interface PluginManifestEngine {
  keygate?: string;
}

export interface PluginManifestRaw {
  schemaVersion?: unknown;
  id?: unknown;
  name?: unknown;
  version?: unknown;
  description?: unknown;
  entry?: unknown;
  engine?: unknown;
  skillsDirs?: unknown;
  configSchema?: unknown;
  cli?: unknown;
  enabled?: unknown;
  requiresConfig?: unknown;
}

export interface PluginManifest {
  schemaVersion: number;
  id?: string;
  name: string;
  version?: string;
  description?: string;
  entry?: string;
  engine?: PluginManifestEngine;
  skillsDirs: string[];
  configSchema?: string;
  cli?: PluginManifestCli;
  enabled: boolean;
  requiresConfig: string[];
}

export interface ResolvedPluginManifest extends PluginManifest {
  runtimeCapable: boolean;
  rootDir: string;
  manifestPath: string;
  entryPath?: string;
  configSchemaPath?: string;
  skillDirPaths: string[];
  sourceKind: PluginSourceKind;
  scope: PluginScope | null;
  precedence: number;
}

export interface PluginDiagnostic {
  location: string;
  error: string;
}

export interface PluginSourceRoot {
  path: string;
  sourceKind: PluginSourceKind;
  scope: PluginScope | null;
  precedence: number;
}

export interface PluginCatalogSnapshot {
  roots: PluginSourceRoot[];
  manifests: ResolvedPluginManifest[];
  diagnostics: PluginDiagnostic[];
  duplicates: Array<{ id: string; kept: string; dropped: string }>;
  commandCollisions: Array<{ command: string; pluginIds: string[] }>;
  pluginSkillRoots: string[];
}

export interface PluginConfigValidationIssue {
  path: string;
  message: string;
}

export interface PluginConfigValidationResult {
  valid: boolean;
  issues: PluginConfigValidationIssue[];
  schema: Record<string, unknown> | null;
}

export interface PluginInstallRecord {
  id: string;
  source: string;
  scope: PluginScope;
  linked: boolean;
  installedAt: string;
  updatedAt: string;
  resolvedVersion: string;
}

export interface PluginInstallState {
  records: Record<string, PluginInstallRecord>;
}

export interface PluginInstallRequest {
  source: string;
  scope: PluginScope;
  link?: boolean;
  nodeManager: NodeManager;
}

export interface PluginInstallResult {
  manifest: ResolvedPluginManifest;
  record: PluginInstallRecord;
  targetDir: string;
}

export interface PluginLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

export interface PluginHttpRequestContext {
  request: IncomingMessage;
  body: unknown;
  method: PluginHttpMethod;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
}

export type PluginHttpResult =
  | { status: number; json: unknown; headers?: Record<string, string> }
  | { status: number; text: string; headers?: Record<string, string> }
  | { status: number; body: Uint8Array; contentType: string; headers?: Record<string, string> };

export interface PluginToolDefinition extends Omit<ToolDefinition, 'name'> {
  name: string;
  handler: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolResult>;
}

export interface PluginServiceDefinition {
  id: string;
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
}

export interface PluginHttpRouteDefinition {
  method: PluginHttpMethod;
  path: string;
  auth: PluginHttpAuth;
  handler: (context: PluginHttpRequestContext) => Promise<PluginHttpResult> | PluginHttpResult;
}

export interface PluginCliRunContext {
  argv: ParsedArgs;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

export interface PluginCliCommandDefinition {
  name: string;
  description: string;
  usage?: string;
  run: (context: PluginCliRunContext) => Promise<void> | void;
}

export type PluginRpcHandler = (params: unknown) => Promise<unknown> | unknown;

export interface PluginPaths {
  root: string;
  manifest: string;
  entry?: string;
  configSchema?: string;
}

export interface PluginEventsApi {
  on<TEventName extends keyof KeygateEvents>(
    eventName: TEventName,
    listener: (payload: KeygateEvents[TEventName]) => void
  ): void;
}

export interface PluginSetupApi {
  pluginId: string;
  manifest: ResolvedPluginManifest;
  pluginConfig: Record<string, unknown>;
  env: Record<string, string>;
  coreConfig: KeygateConfig;
  logger: PluginLogger;
  paths: PluginPaths;
  events: PluginEventsApi;
  sendMessageToSession(sessionId: string, content: string, source?: string): Promise<void>;
  listSessions(): Array<{ id: string; channelType: string; title?: string; updatedAt: string }>;
  getSessionHistory(sessionId: string, limit?: number): Array<{ role: string; content: string }>;
  registerHook(name: PluginHookName, handler: PluginHookHandler, options?: { priority?: number }): void;
  registerTool(definition: PluginToolDefinition): void;
  registerRpcMethod(name: string, handler: PluginRpcHandler): void;
  registerHttpRoute(definition: PluginHttpRouteDefinition): void;
  registerCliCommand(definition: PluginCliCommandDefinition): void;
  registerService(definition: PluginServiceDefinition): void;
}

export interface KeygateRuntimePlugin {
  setup(api: PluginSetupApi): Promise<void> | void;
}

export interface PluginStage {
  tools: Tool[];
  toolNames: string[];
  hooks: Array<{
    name: PluginHookName;
    priority: number;
    handler: PluginHookHandler;
  }>;
  rpcMethods: Map<string, PluginRpcHandler>;
  httpRoutes: PluginHttpRouteDefinition[];
  cliCommands: PluginCliCommandDefinition[];
  services: PluginServiceDefinition[];
  eventSubscriptions: Array<{
    eventName: keyof KeygateEvents;
    listener: (payload: KeygateEvents[keyof KeygateEvents]) => void;
  }>;
}

export interface ActivePluginState {
  manifest: ResolvedPluginManifest;
  status: PluginStatus;
  lastError: string | null;
  tools: string[];
  rpcMethods: string[];
  httpRoutes: Array<{ method: PluginHttpMethod; path: string; auth: PluginHttpAuth }>;
  cliCommands: string[];
  serviceIds: string[];
  install?: PluginInstallRecord;
  configSchema: Record<string, unknown> | null;
}

export interface PluginListItem extends ActivePluginState {
  enabled: boolean;
  sourceKind: PluginSourceKind;
  scope: PluginScope | null;
  version: string | null;
  description: string | null;
  diagnostics: PluginDiagnostic[];
}

export interface PluginInfo extends PluginListItem {
  manifestJson: Record<string, unknown>;
  config: Record<string, unknown>;
  env: Record<string, string>;
}
