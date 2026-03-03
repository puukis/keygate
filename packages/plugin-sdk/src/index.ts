export type PluginHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type PluginHttpAuth = 'public' | 'operator';

export interface PluginHttpResultJson {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

export interface PluginHttpResultText {
  status: number;
  text: string;
  headers?: Record<string, string>;
}

export interface PluginHttpResultBinary {
  status: number;
  body: Uint8Array;
  contentType: string;
  headers?: Record<string, string>;
}

export type PluginHttpResult = PluginHttpResultJson | PluginHttpResultText | PluginHttpResultBinary;

export interface PluginToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  requiresConfirmation: boolean;
  type: 'filesystem' | 'shell' | 'sandbox' | 'search' | 'browser' | 'other';
  handler: (args: Record<string, unknown>, context: {
    signal: AbortSignal;
    registerAbortCleanup: (cleanup: () => void | Promise<void>) => void;
  }) => Promise<{ success: boolean; output: string; error?: string }>;
}

export interface PluginHttpRouteDefinition {
  method: PluginHttpMethod;
  path: string;
  auth: PluginHttpAuth;
  handler: (context: {
    request: unknown;
    body: unknown;
    method: PluginHttpMethod;
    path: string;
    query: URLSearchParams;
    headers: Record<string, string>;
  }) => Promise<PluginHttpResult> | PluginHttpResult;
}

export interface PluginCliCommandDefinition {
  name: string;
  description: string;
  usage?: string;
  run: (context: {
    argv: {
      positional: string[];
      flags: Record<string, string | boolean>;
    };
    stdout: NodeJS.WriteStream;
    stderr: NodeJS.WriteStream;
  }) => Promise<void> | void;
}

export interface PluginServiceDefinition {
  id: string;
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
}

export interface PluginSetupApi {
  pluginId: string;
  manifest: Record<string, unknown>;
  pluginConfig: Record<string, unknown>;
  env: Record<string, string>;
  coreConfig: Record<string, unknown>;
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
    debug(message: string, meta?: Record<string, unknown>): void;
  };
  paths: {
    root: string;
    manifest: string;
    entry?: string;
    configSchema?: string;
  };
  events: {
    on(eventName: string, listener: (payload: unknown) => void): void;
  };
  sendMessageToSession(sessionId: string, content: string, source?: string): Promise<void>;
  listSessions(): Array<{ id: string; channelType: string; title?: string; updatedAt: string }>;
  getSessionHistory(sessionId: string, limit?: number): Array<{ role: string; content: string }>;
  registerTool(definition: PluginToolDefinition): void;
  registerRpcMethod(name: string, handler: (params: unknown) => Promise<unknown> | unknown): void;
  registerHttpRoute(definition: PluginHttpRouteDefinition): void;
  registerCliCommand(definition: PluginCliCommandDefinition): void;
  registerService(definition: PluginServiceDefinition): void;
}

export interface KeygateRuntimePlugin {
  setup(api: PluginSetupApi): Promise<void> | void;
}

export function definePlugin(plugin: KeygateRuntimePlugin): KeygateRuntimePlugin {
  return plugin;
}

export function definePluginConfigSchema<TSchema extends Record<string, unknown>>(schema: TSchema): TSchema {
  return schema;
}

export function isPluginHttpResult(value: unknown): value is PluginHttpResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const status = (value as Record<string, unknown>)['status'];
  return typeof status === 'number' && Number.isFinite(status);
}
