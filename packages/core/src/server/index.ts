import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Gateway } from '../gateway/index.js';
import { normalizeWebMessage, BaseChannel } from '../pipeline/index.js';
import { allBuiltinTools } from '../tools/index.js';
import { updateKeygateFile } from '../config/env.js';
import { MCPBrowserManager, type MCPBrowserStatus } from '../codex/mcpBrowserManager.js';
import type {
  BrowserDomainPolicy,
  ChannelType,
  CodexReasoningEffort,
  ConfirmationDecision,
  ConfirmationDetails,
  KeygateConfig,
  Session,
  SecurityMode,
} from '../types.js';

interface WSMessage {
  type:
    | 'message'
    | 'get_session_snapshot'
    | 'confirm_response'
    | 'set_mode'
    | 'enable_spicy_mode'
    | 'set_spicy_obedience'
    | 'set_discord_config'
    | 'clear_session'
    | 'get_models'
    | 'set_model'
    | 'get_mcp_browser_status'
    | 'setup_mcp_browser'
    | 'remove_mcp_browser'
    | 'set_browser_policy';
  sessionId?: string;
  content?: string;
  decision?: ConfirmationDecision;
  confirmed?: boolean;
  mode?: SecurityMode;
  enabled?: boolean;
  riskAck?: string;
  prefix?: string;
  token?: string;
  clearToken?: boolean;
  provider?: KeygateConfig['llm']['provider'];
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  domainPolicy?: BrowserDomainPolicy;
  domainAllowlist?: string[] | string;
  domainBlocklist?: string[] | string;
  traceRetentionDays?: number;
  mcpPlaywrightVersion?: string;
}

interface StartWebServerOptions {
  onListening?: () => void | Promise<void>;
  staticAssetsDir?: string;
}

interface DiscordConfigView {
  configured: boolean;
  prefix: string;
}

interface BrowserConfigView {
  installed: boolean;
  healthy: boolean;
  serverName: string;
  configuredVersion: string | null;
  desiredVersion: string;
  domainPolicy: BrowserDomainPolicy;
  domainAllowlist: string[];
  domainBlocklist: string[];
  traceRetentionDays: number;
  artifactsPath: string;
  command: string | null;
  args: string[];
  warning?: string;
}

export interface BrowserStatusTracker {
  hasBaseline: boolean;
  signature: string | null;
}

interface SessionSnapshotMessageView {
  role: 'user' | 'assistant';
  content: string;
}

interface SessionSnapshotEntryView {
  sessionId: string;
  channelType: ChannelType;
  updatedAt: string;
  messages: SessionSnapshotMessageView[];
}

const DEFAULT_DISCORD_PREFIX = '!keygate ';
const BROWSER_RETENTION_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * WebSocket Channel adapter
 */
class WebSocketChannel extends BaseChannel {
  type = 'web' as const;
  private ws: WebSocket;
  private sessionId: string;
  private pendingConfirmation:
    | {
      resolve: (decision: ConfirmationDecision) => void;
    }
    | null = null;
  private confirmationQueue: Array<{
    prompt: string;
    details?: ConfirmationDetails;
    resolve: (decision: ConfirmationDecision) => void;
  }> = [];

  constructor(ws: WebSocket, sessionId: string) {
    super();
    this.ws = ws;
    this.sessionId = sessionId;
  }

  async send(content: string): Promise<void> {
    this.ws.send(JSON.stringify({
      type: 'message',
      sessionId: this.sessionId,
      content,
    }));
  }

  async sendStream(stream: AsyncIterable<string>): Promise<void> {
    for await (const chunk of stream) {
      this.ws.send(JSON.stringify({
        type: 'chunk',
        sessionId: this.sessionId,
        content: chunk,
      }));
    }
    this.ws.send(JSON.stringify({
      type: 'stream_end',
      sessionId: this.sessionId,
    }));
  }

  async requestConfirmation(prompt: string, details?: ConfirmationDetails): Promise<ConfirmationDecision> {
    return new Promise((resolve) => {
      this.confirmationQueue.push({ prompt, details, resolve });
      this.flushConfirmationQueue();
    });
  }

  handleConfirmResponse(decision: ConfirmationDecision): void {
    if (!this.pendingConfirmation) {
      return;
    }

    const pending = this.pendingConfirmation;
    this.pendingConfirmation = null;
    pending.resolve(decision);
    this.flushConfirmationQueue();
  }

  handleDisconnect(): void {
    if (this.pendingConfirmation) {
      const pending = this.pendingConfirmation;
      this.pendingConfirmation = null;
      pending.resolve('cancel');
    }

    for (const confirmation of this.confirmationQueue) {
      confirmation.resolve('cancel');
    }
    this.confirmationQueue = [];
  }

  private flushConfirmationQueue(): void {
    if (this.pendingConfirmation) {
      return;
    }

    const next = this.confirmationQueue.shift();
    if (!next) {
      return;
    }

    if (this.ws.readyState !== WebSocket.OPEN) {
      next.resolve('cancel');
      this.flushConfirmationQueue();
      return;
    }

    this.pendingConfirmation = { resolve: next.resolve };
    this.ws.send(JSON.stringify({
      type: 'confirm_request',
      sessionId: this.sessionId,
      prompt: next.prompt,
      details: next.details,
    }));
  }
}

/**
 * Start the WebSocket server
 */
export function startWebServer(config: KeygateConfig, options: StartWebServerOptions = {}): void {
  const gateway = Gateway.getInstance(config);
  const staticAssetsDir = options.staticAssetsDir;
  const mcpBrowserManager = new MCPBrowserManager(config);
  const browserStatusTracker: BrowserStatusTracker = {
    hasBaseline: false,
    signature: null,
  };

  void mcpBrowserManager.cleanupArtifacts().catch((error) => {
    console.warn('Failed initial browser artifact cleanup:', error);
  });

  void mcpBrowserManager.status()
    .then((status) => {
      browserStatusTracker.signature = buildBrowserStatusSignature(status);
      browserStatusTracker.hasBaseline = true;
    })
    .catch((error) => {
      console.warn('Failed initial MCP browser status check:', error);
    });

  const browserCleanupInterval = setInterval(() => {
    void mcpBrowserManager.cleanupArtifacts().catch((error) => {
      console.warn('Failed periodic browser artifact cleanup:', error);
    });
  }, BROWSER_RETENTION_CLEANUP_INTERVAL_MS);
  

  // Register all built-in tools
  for (const tool of allBuiltinTools) {
    gateway.toolExecutor.registerTool(tool);
  }

  const server = createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');

    // Simple REST endpoints
    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildStatusPayload(gateway, config)));
      return;
    }

    if (url.pathname === '/api/browser/latest') {
      void serveLatestBrowserScreenshot(res, req.method, url, config.browser.artifactsPath);
      return;
    }

    if (url.pathname === '/api/browser/image') {
      void serveBrowserScreenshotByFilename(res, req.method, url, config.browser.artifactsPath);
      return;
    }

    if (staticAssetsDir && req.method && ['GET', 'HEAD'].includes(req.method)) {
      void serveStaticAsset(res, staticAssetsDir, url.pathname, req.method === 'HEAD');
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  const wss = new WebSocketServer({ server });
  const channels = new Map<string, WebSocketChannel>();

  wss.on('connection', (ws) => {
    const sessionId = crypto.randomUUID();
    const channel = new WebSocketChannel(ws, sessionId);
    channels.set(sessionId, channel);
    const llmState = gateway.getLLMState();
    const webSessionId = `web:${sessionId}`;

    console.log(`Client connected: ${sessionId}`);

    // Send initial state
    ws.send(JSON.stringify(buildConnectedPayload(sessionId, gateway, llmState, config)));
    ws.send(JSON.stringify(buildSessionSnapshotPayload(gateway, webSessionId)));

    void sendModels(ws, gateway, llmState.provider);
    void sendMcpBrowserStatus(ws, gateway, mcpBrowserManager, browserStatusTracker);

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString()) as WSMessage;

        switch (msg.type) {
          case 'message': {
            const content = msg.content?.trim();
            if (!content) return;

            const normalized = normalizeWebMessage(
              sessionId,
              'web-user',
              content,
              channel
            );

            // Send acknowledgment
            ws.send(JSON.stringify({ type: 'message_received', sessionId }));

            await gateway.processMessage(normalized);
            break;
          }

          case 'get_session_snapshot': {
            ws.send(JSON.stringify(buildSessionSnapshotPayload(gateway, webSessionId)));
            break;
          }

          case 'confirm_response': {
            const decision = msg.decision ?? (msg.confirmed ? 'allow_once' : 'cancel');
            channel.handleConfirmResponse(decision);
            break;
          }

          case 'set_mode': {
            if (msg.mode) {
              try {
                gateway.setSecurityMode(msg.mode);
                ws.send(JSON.stringify({
                  type: 'mode_changed',
                  mode: msg.mode,
                }));
              } catch (error) {
                ws.send(JSON.stringify({
                  type: 'error',
                  error: error instanceof Error ? error.message : 'Failed to change mode',
                }));
              }
            }
            break;
          }

          case 'enable_spicy_mode': {
            const ack = typeof msg.riskAck === 'string' ? msg.riskAck.trim() : '';
            if (ack !== 'I ACCEPT THE RISK') {
              ws.send(JSON.stringify({
                type: 'error',
                error: 'To enable spicy mode, type I ACCEPT THE RISK exactly.',
              }));
              break;
            }

            try {
              await applySpicyModeEnable(gateway);
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Failed to enable spicy mode',
              }));
            }
            break;
          }

          case 'set_spicy_obedience': {
            if (typeof msg.enabled !== 'boolean') {
              ws.send(JSON.stringify({
                type: 'error',
                error: 'Enabled flag is required',
              }));
              break;
            }

            try {
              await applySpicyObedienceUpdate(gateway, msg.enabled);
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Failed to set spicy obedience toggle',
              }));
            }
            break;
          }

          case 'set_discord_config': {
            if (typeof msg.prefix !== 'string') {
              ws.send(JSON.stringify({
                type: 'error',
                error: 'Discord prefix is required',
              }));
              break;
            }

            try {
              const discord = await applyDiscordConfigUpdate(
                config,
                {
                  prefix: msg.prefix,
                  token: typeof msg.token === 'string' ? msg.token : undefined,
                  clearToken: msg.clearToken === true,
                }
              );

              ws.send(JSON.stringify({
                type: 'discord_config_updated',
                discord,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Failed to save Discord configuration',
              }));
            }
            break;
          }

          case 'clear_session': {
            gateway.clearSession(webSessionId);
            ws.send(JSON.stringify({ type: 'session_cleared', sessionId }));
            break;
          }

          case 'get_models': {
            await sendModels(ws, gateway, msg.provider ?? gateway.getLLMState().provider);
            break;
          }

          case 'set_model': {
            const provider = msg.provider ?? gateway.getLLMState().provider;
            const model = msg.model?.trim();
            const reasoningEffort = provider === 'openai-codex'
              ? normalizeCodexReasoningEffort(msg.reasoningEffort)
              : undefined;

            if (!model) {
              ws.send(JSON.stringify({
                type: 'error',
                error: 'Model is required',
              }));
              break;
            }

            if (provider === 'openai-codex' && typeof msg.reasoningEffort === 'string' && !reasoningEffort) {
              ws.send(JSON.stringify({
                type: 'error',
                error: 'Invalid reasoning effort. Expected low, medium, high, or xhigh.',
              }));
              break;
            }

            if (provider === 'openai-codex' && !isCodexInstalled()) {
              ws.send(JSON.stringify({
                type: 'codex_install_required',
                provider,
                message: 'Codex CLI is not installed. Run `keygate onboard --auth-choice openai-codex`.',
              }));
              break;
            }

            try {
              await gateway.setLLMSelection(provider, model, reasoningEffort);
              const state = gateway.getLLMState();
              ws.send(JSON.stringify({
                type: 'model_changed',
                llm: state,
              }));
              await sendModels(ws, gateway, state.provider);
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Failed to switch model',
              }));
            }
            break;
          }

          case 'get_mcp_browser_status': {
            await sendMcpBrowserStatus(ws, gateway, mcpBrowserManager, browserStatusTracker);
            break;
          }

          case 'setup_mcp_browser': {
            try {
              await mcpBrowserManager.setup();
              await sendMcpBrowserStatus(ws, gateway, mcpBrowserManager, browserStatusTracker);
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Failed to install MCP browser server',
              }));
            }
            break;
          }

          case 'remove_mcp_browser': {
            try {
              await mcpBrowserManager.remove();
              await sendMcpBrowserStatus(ws, gateway, mcpBrowserManager, browserStatusTracker);
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Failed to remove MCP browser server',
              }));
            }
            break;
          }

          case 'set_browser_policy': {
            try {
              await applyBrowserPolicyUpdate(config, {
                domainPolicy: msg.domainPolicy,
                domainAllowlist: msg.domainAllowlist,
                domainBlocklist: msg.domainBlocklist,
                traceRetentionDays: msg.traceRetentionDays,
                mcpPlaywrightVersion: msg.mcpPlaywrightVersion,
              });

              const browserStatus = await mcpBrowserManager.status();
              if (browserStatus.installed) {
                await mcpBrowserManager.setup();
              }

              await sendMcpBrowserStatus(ws, gateway, mcpBrowserManager, browserStatusTracker);
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Failed to update browser policy',
              }));
            }
            break;
          }
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
        ws.send(JSON.stringify({
          type: 'error',
          error: 'Invalid message format',
        }));
      }
    });

    ws.on('close', () => {
      channel.handleDisconnect();
      console.log(`Client disconnected: ${sessionId}`);
      channels.delete(sessionId);
    });
  });

  // Forward gateway events to all connected clients
  gateway.on('message:user', (event) => {
    broadcast(wss, buildSessionUserMessagePayload(event));
  });

  gateway.on('message:chunk', (event) => {
    broadcast(wss, buildSessionChunkPayload(event));
  });

  gateway.on('message:end', (event) => {
    broadcast(wss, buildSessionMessageEndPayload(event));
  });

  gateway.on('tool:start', (event) => {
    broadcast(wss, { type: 'tool_start', ...event });
  });

  gateway.on('tool:end', (event) => {
    broadcast(wss, { type: 'tool_end', ...event });
  });

  gateway.on('mode:changed', (event) => {
    broadcast(wss, { type: 'mode_changed', ...event });
  });

  gateway.on('spicy_enabled:changed', (event) => {
    broadcast(wss, { type: 'spicy_enabled_changed', ...event });
  });

  gateway.on('spicy_obedience:changed', (event) => {
    broadcast(wss, { type: 'spicy_obedience_changed', ...event });
  });

  gateway.on('provider:event', (event) => {
    broadcast(wss, { type: 'provider_event', ...event });
  });

  server.listen(config.server.port, () => {
    console.log(`🌐 Keygate Web Server running on http://localhost:${config.server.port}`);

    if (options.onListening) {
      void Promise.resolve(options.onListening()).catch((error) => {
        console.error('Startup hook failed:', error);
      });
    }
  });

  server.on('close', () => {
    clearInterval(browserCleanupInterval);
  });
}

function broadcast(wss: WebSocketServer, data: object): void {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

export { WebSocketChannel };

export function buildStatusPayload(gateway: Gateway, config: KeygateConfig): Record<string, unknown> {
  return {
    status: 'ok',
    mode: gateway.getSecurityMode(),
    spicyEnabled: gateway.getSpicyModeEnabled(),
    spicyObedienceEnabled: gateway.getSpicyMaxObedienceEnabled(),
    llm: gateway.getLLMState(),
    discord: buildDiscordConfigView(config),
    browser: buildBrowserConfigViewFromConfig(config),
  };
}

export function buildConnectedPayload(
  sessionId: string,
  gateway: Gateway,
  llmState: ReturnType<Gateway['getLLMState']>,
  config: KeygateConfig
): Record<string, unknown> {
  return {
    type: 'connected',
    sessionId,
    mode: gateway.getSecurityMode(),
    spicyEnabled: gateway.getSpicyModeEnabled(),
    spicyObedienceEnabled: gateway.getSpicyMaxObedienceEnabled(),
    llm: llmState,
    discord: buildDiscordConfigView(config),
    browser: buildBrowserConfigViewFromConfig(config),
  };
}

export function buildSessionSnapshotPayload(
  gateway: Gateway,
  webSessionId: string
): Record<string, unknown> {
  const sessions = gateway.listSessions();
  const visibleSessions = sessions.filter((session) => (
    session.id === webSessionId || session.channelType === 'discord'
  ));

  if (!visibleSessions.some((session) => session.id === webSessionId)) {
    visibleSessions.push({
      id: webSessionId,
      channelType: 'web',
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  const serialized = visibleSessions
    .sort((left, right) => {
      if (left.id === webSessionId && right.id !== webSessionId) {
        return -1;
      }
      if (right.id === webSessionId && left.id !== webSessionId) {
        return 1;
      }
      return right.updatedAt.getTime() - left.updatedAt.getTime();
    })
    .map((session) => serializeSessionSnapshotEntry(session));

  return {
    type: 'session_snapshot',
    sessions: serialized,
  };
}

export function buildSessionUserMessagePayload(event: {
  sessionId: string;
  channelType: ChannelType;
  content: string;
}): Record<string, unknown> {
  return {
    type: 'session_user_message',
    sessionId: event.sessionId,
    channelType: event.channelType,
    content: event.content,
  };
}

export function buildSessionChunkPayload(event: {
  sessionId: string;
  content: string;
}): Record<string, unknown> {
  return {
    type: 'session_chunk',
    sessionId: event.sessionId,
    content: event.content,
  };
}

export function buildSessionMessageEndPayload(event: {
  sessionId: string;
  content: string;
}): Record<string, unknown> {
  return {
    type: 'session_message_end',
    sessionId: event.sessionId,
    content: event.content,
  };
}

export async function applySpicyModeEnable(
  gateway: Gateway,
  persistConfigUpdate: typeof updateKeygateFile = updateKeygateFile
): Promise<void> {
  const previous = gateway.getSpicyModeEnabled();
  if (previous) {
    return;
  }

  gateway.setSpicyModeEnabled(true);
  try {
    await persistConfigUpdate({
      SPICY_MODE_ENABLED: 'true',
    });
  } catch (error) {
    gateway.setSpicyModeEnabled(previous);
    throw error;
  }
}

export async function applySpicyObedienceUpdate(
  gateway: Gateway,
  enabled: boolean,
  persistConfigUpdate: typeof updateKeygateFile = updateKeygateFile
): Promise<void> {
  const previous = gateway.getSpicyMaxObedienceEnabled();

  gateway.setSpicyMaxObedienceEnabled(enabled);
  try {
    await persistConfigUpdate({
      SPICY_MAX_OBEDIENCE_ENABLED: enabled ? 'true' : 'false',
    });
  } catch (error) {
    gateway.setSpicyMaxObedienceEnabled(previous);
    throw error;
  }
}

export async function applyDiscordConfigUpdate(
  config: KeygateConfig,
  update: {
    prefix: string;
    token?: string;
    clearToken?: boolean;
  },
  persistConfigUpdate: typeof updateKeygateFile = updateKeygateFile
): Promise<DiscordConfigView> {
  const prefix = normalizeDiscordPrefix(update.prefix, false);
  if (prefix.length === 0) {
    throw new Error('Discord prefix list cannot be empty.');
  }

  const currentToken = config.discord?.token ?? process.env['DISCORD_TOKEN'] ?? '';
  const hasTokenUpdate = typeof update.token === 'string' && update.token.trim().length > 0;
  const shouldClearToken = update.clearToken === true;
  const nextToken = shouldClearToken
    ? ''
    : hasTokenUpdate
      ? update.token!.trim()
      : currentToken;

  const envUpdates: Record<string, string> = {
    DISCORD_PREFIX: prefix,
  };

  if (hasTokenUpdate || shouldClearToken) {
    envUpdates['DISCORD_TOKEN'] = nextToken;
  }

  await persistConfigUpdate(envUpdates);

  const existingDiscord = config.discord ?? { token: currentToken, prefix };
  existingDiscord.prefix = prefix;
  if (hasTokenUpdate || shouldClearToken) {
    existingDiscord.token = nextToken;
  }
  config.discord = existingDiscord;

  process.env['DISCORD_PREFIX'] = prefix;
  if (hasTokenUpdate || shouldClearToken) {
    process.env['DISCORD_TOKEN'] = nextToken;
  }

  return buildDiscordConfigView(config);
}

export async function applyBrowserPolicyUpdate(
  config: KeygateConfig,
  update: {
    domainPolicy?: BrowserDomainPolicy;
    domainAllowlist?: string[] | string;
    domainBlocklist?: string[] | string;
    traceRetentionDays?: number;
    mcpPlaywrightVersion?: string;
  },
  persistConfigUpdate: typeof updateKeygateFile = updateKeygateFile
): Promise<BrowserConfigView> {
  const nextDomainPolicy = normalizeBrowserDomainPolicy(update.domainPolicy ?? config.browser.domainPolicy);
  const nextAllowlist = update.domainAllowlist === undefined
    ? [...config.browser.domainAllowlist]
    : parseBrowserOrigins(update.domainAllowlist);
  const nextBlocklist = update.domainBlocklist === undefined
    ? [...config.browser.domainBlocklist]
    : parseBrowserOrigins(update.domainBlocklist);
  const nextRetentionDays = parseTraceRetentionDays(update.traceRetentionDays, config.browser.traceRetentionDays);
  const nextPlaywrightVersion = normalizePlaywrightVersion(update.mcpPlaywrightVersion, config.browser.mcpPlaywrightVersion);

  if (nextDomainPolicy === 'allowlist' && nextAllowlist.length === 0) {
    throw new Error('Allowlist policy requires at least one allowed origin.');
  }

  if (nextDomainPolicy === 'blocklist' && nextBlocklist.length === 0) {
    throw new Error('Blocklist policy requires at least one blocked origin.');
  }

  await persistConfigUpdate({
    BROWSER_DOMAIN_POLICY: nextDomainPolicy,
    BROWSER_DOMAIN_ALLOWLIST: nextAllowlist.join(', '),
    BROWSER_DOMAIN_BLOCKLIST: nextBlocklist.join(', '),
    BROWSER_TRACE_RETENTION_DAYS: String(nextRetentionDays),
    MCP_PLAYWRIGHT_VERSION: nextPlaywrightVersion,
  });

  config.browser.domainPolicy = nextDomainPolicy;
  config.browser.domainAllowlist = nextAllowlist;
  config.browser.domainBlocklist = nextBlocklist;
  config.browser.traceRetentionDays = nextRetentionDays;
  config.browser.mcpPlaywrightVersion = nextPlaywrightVersion;

  process.env['BROWSER_DOMAIN_POLICY'] = nextDomainPolicy;
  process.env['BROWSER_DOMAIN_ALLOWLIST'] = nextAllowlist.join(', ');
  process.env['BROWSER_DOMAIN_BLOCKLIST'] = nextBlocklist.join(', ');
  process.env['BROWSER_TRACE_RETENTION_DAYS'] = String(nextRetentionDays);
  process.env['MCP_PLAYWRIGHT_VERSION'] = nextPlaywrightVersion;

  return buildBrowserConfigViewFromConfig(config);
}

function parseBrowserOrigins(value: string[] | string): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(
      value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0)
    ));
  }

  return Array.from(new Set(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  ));
}

function normalizeBrowserDomainPolicy(value: unknown): BrowserDomainPolicy {
  if (typeof value !== 'string') {
    return 'none';
  }

  switch (value.trim().toLowerCase()) {
    case 'allowlist':
      return 'allowlist';
    case 'blocklist':
      return 'blocklist';
    default:
      return 'none';
  }
}

function parseTraceRetentionDays(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number'
    ? value
    : Number.parseInt(typeof value === 'string' ? value : '', 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.floor(parsed);
}

function normalizePlaywrightVersion(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim();
  if (!normalized) {
    return fallback;
  }

  return normalized;
}

function buildBrowserConfigViewFromConfig(config: KeygateConfig): BrowserConfigView {
  return {
    installed: false,
    healthy: false,
    serverName: 'playwright',
    configuredVersion: null,
    desiredVersion: config.browser.mcpPlaywrightVersion,
    domainPolicy: config.browser.domainPolicy,
    domainAllowlist: [...config.browser.domainAllowlist],
    domainBlocklist: [...config.browser.domainBlocklist],
    traceRetentionDays: config.browser.traceRetentionDays,
    artifactsPath: path.resolve(config.browser.artifactsPath),
    command: null,
    args: [],
  };
}

function toBrowserConfigView(status: MCPBrowserStatus): BrowserConfigView {
  return {
    installed: status.installed,
    healthy: status.healthy,
    serverName: status.serverName,
    configuredVersion: status.configuredVersion,
    desiredVersion: status.desiredVersion,
    domainPolicy: status.domainPolicy,
    domainAllowlist: [...status.domainAllowlist],
    domainBlocklist: [...status.domainBlocklist],
    traceRetentionDays: status.traceRetentionDays,
    artifactsPath: status.artifactsPath,
    command: status.command,
    args: [...status.args],
    warning: status.warning,
  };
}

function serializeSessionSnapshotEntry(session: Session): SessionSnapshotEntryView {
  return {
    sessionId: session.id,
    channelType: session.channelType,
    updatedAt: session.updatedAt.toISOString(),
    messages: session.messages
      .filter((message): message is Session['messages'][number] & { role: 'user' | 'assistant' } => (
        message.role === 'user' || message.role === 'assistant'
      ))
      .map((message) => ({
        role: message.role,
        content: message.content,
      })),
  };
}

async function sendModels(
  ws: WebSocket,
  gateway: Gateway,
  provider: KeygateConfig['llm']['provider']
): Promise<void> {
  try {
    const models = await gateway.listAvailableModels(provider);
    ws.send(JSON.stringify({
      type: 'models',
      provider,
      models,
    }));
  } catch (error) {
    ws.send(JSON.stringify({
      type: 'models',
      provider,
      models: [],
      error: error instanceof Error ? error.message : 'Failed to fetch models',
    }));
  }
}


export async function sendMcpBrowserStatus(
  ws: WebSocket,
  gateway: Gateway,
  manager: MCPBrowserManager,
  tracker: BrowserStatusTracker
): Promise<void> {
  const status = await manager.status();
  await maybeRefreshCodexProviderForBrowserStatusChange(gateway, status, tracker);

  ws.send(JSON.stringify({
    type: 'mcp_browser_status',
    browser: toBrowserConfigView(status),
  }));
}

export function buildBrowserStatusSignature(status: MCPBrowserStatus): string {
  const command = status.command ?? '';
  const args = status.args.join('\u001f');
  return [
    status.installed ? '1' : '0',
    status.healthy ? '1' : '0',
    status.configuredVersion ?? '',
    status.desiredVersion,
    command,
    args,
  ].join('|');
}

export async function maybeRefreshCodexProviderForBrowserStatusChange(
  gateway: Gateway,
  status: MCPBrowserStatus,
  tracker: BrowserStatusTracker
): Promise<void> {
  const nextSignature = buildBrowserStatusSignature(status);

  if (!tracker.hasBaseline) {
    tracker.signature = nextSignature;
    tracker.hasBaseline = true;
    return;
  }

  if (tracker.signature === nextSignature) {
    return;
  }

  tracker.signature = nextSignature;
  await refreshCodexProviderContext(gateway);
}

async function refreshCodexProviderContext(gateway: Gateway): Promise<void> {
  const llmState = gateway.getLLMState();
  if (llmState.provider !== 'openai-codex') {
    return;
  }

  try {
    await gateway.setLLMSelection(
      llmState.provider,
      llmState.model,
      llmState.reasoningEffort
    );
  } catch (error) {
    console.warn('Failed to refresh Codex provider context after MCP browser change:', error);
  }
}
function isCodexInstalled(): boolean {
  const result = spawnSync('codex', ['--version'], {
    stdio: 'pipe',
  });

  return result.status === 0;
}

function normalizeCodexReasoningEffort(value: unknown): CodexReasoningEffort | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  switch (normalized) {
    case 'low':
    case 'medium':
    case 'high':
      return normalized;
    case 'xhigh':
    case 'extra-high':
    case 'extra_high':
    case 'extra high':
      return 'xhigh';
    default:
      return undefined;
  }
}

function buildDiscordConfigView(config: KeygateConfig): DiscordConfigView {
  const token = (config.discord?.token ?? process.env['DISCORD_TOKEN'] ?? '').trim();
  const prefix = normalizeDiscordPrefix(config.discord?.prefix ?? process.env['DISCORD_PREFIX']);

  return {
    configured: token.length > 0,
    prefix,
  };
}

function normalizeDiscordPrefix(value: string | undefined, fallbackToDefault = true): string {
  const parsed = parseDiscordPrefixes(value);
  if (parsed.length === 0) {
    return fallbackToDefault ? DEFAULT_DISCORD_PREFIX : '';
  }

  if (parsed.length === 1 && typeof value === 'string' && !value.includes(',')) {
    return parsed[0]!;
  }

  return parsed.join(', ');
}

function parseDiscordPrefixes(value: string | undefined): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  if (!value.includes(',')) {
    return value.trim().length > 0 ? [value] : [];
  }

  return value
    .split(',')
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix.length > 0);
}


async function serveLatestBrowserScreenshot(
  res: import('node:http').ServerResponse,
  method: string | undefined,
  url: URL,
  artifactsRoot: string
): Promise<void> {
  if (method && !['GET', 'HEAD'].includes(method)) {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const sessionId = sanitizeBrowserSessionId(url.searchParams.get('sessionId'));
  if (!sessionId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Valid sessionId query parameter is required.' }));
    return;
  }

  const latestScreenshot = await resolveLatestSessionScreenshot(artifactsRoot, sessionId);
  if (!latestScreenshot) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No screenshot found for session.' }));
    return;
  }

  const allowedRoots = getBrowserScreenshotAllowedRoots(artifactsRoot);
  if (!allowedRoots.some((rootDir) => isPathWithinRoot(rootDir, latestScreenshot))) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Screenshot path is outside the allowed root.' }));
    return;
  }

  const contentType = getContentType(latestScreenshot);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
  });

  if (method === 'HEAD') {
    res.end();
    return;
  }

  const content = await fs.readFile(latestScreenshot);
  res.end(content);
}

async function serveBrowserScreenshotByFilename(
  res: import('node:http').ServerResponse,
  method: string | undefined,
  url: URL,
  artifactsRoot: string
): Promise<void> {
  if (method && !['GET', 'HEAD'].includes(method)) {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const filename = sanitizeBrowserScreenshotFilename(url.searchParams.get('filename'));
  if (!filename) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Valid filename query parameter is required.' }));
    return;
  }

  const screenshot = await resolveSessionScreenshotByFilename(artifactsRoot, filename);
  if (!screenshot) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Screenshot not found.' }));
    return;
  }

  const allowedRoots = getBrowserScreenshotAllowedRoots(artifactsRoot);
  if (!allowedRoots.some((rootDir) => isPathWithinRoot(rootDir, screenshot))) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Screenshot path is outside the allowed root.' }));
    return;
  }

  const contentType = getContentType(screenshot);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
  });

  if (method === 'HEAD') {
    res.end();
    return;
  }

  const content = await fs.readFile(screenshot);
  res.end(content);
}

export function sanitizeBrowserSessionId(value: string | null): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (!/^[A-Za-z0-9:_-]+$/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

export function sanitizeBrowserScreenshotFilename(value: string | null): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (!/^session-[A-Za-z0-9:_-]+-step-\d+\.png$/i.test(trimmed)) {
    return null;
  }

  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return null;
  }

  return trimmed;
}

export async function resolveLatestSessionScreenshot(
  artifactsRoot: string,
  sessionId: string
): Promise<string | null> {
  const [resolvedArtifactsRoot, resolvedWorkspaceRoot] = getBrowserScreenshotAllowedRoots(artifactsRoot);
  const prefix = `session-${sessionId}-step-`;

  let bestPath: string | null = null;
  let bestMtime = 0;

  async function considerCandidate(fullPath: string, filename: string): Promise<void> {
    if (!filename.toLowerCase().endsWith('.png')) {
      return;
    }

    if (!filename.startsWith(prefix)) {
      return;
    }

    try {
      const stat = await fs.stat(fullPath);
      if (stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs;
        bestPath = fullPath;
      }
    } catch {
      // Ignore unreadable files.
    }
  }

  async function walkArtifacts(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[] = [];

    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.resolve(path.join(dir, entry.name));
      if (!isPathWithinRoot(resolvedArtifactsRoot, fullPath)) {
        continue;
      }

      if (entry.isDirectory()) {
        await walkArtifacts(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      await considerCandidate(fullPath, entry.name);
    }
  }

  async function scanWorkspaceRoot(): Promise<void> {
    let entries: import('node:fs').Dirent[] = [];

    try {
      entries = await fs.readdir(resolvedWorkspaceRoot, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const fullPath = path.resolve(path.join(resolvedWorkspaceRoot, entry.name));
      if (!isPathWithinRoot(resolvedWorkspaceRoot, fullPath)) {
        continue;
      }

      await considerCandidate(fullPath, entry.name);
    }
  }

  await walkArtifacts(resolvedArtifactsRoot);
  await scanWorkspaceRoot();
  return bestPath;
}

export async function resolveSessionScreenshotByFilename(
  artifactsRoot: string,
  filename: string
): Promise<string | null> {
  const [resolvedArtifactsRoot, resolvedWorkspaceRoot] = getBrowserScreenshotAllowedRoots(artifactsRoot);

  let bestPath: string | null = null;
  let bestMtime = 0;
  const targetName = filename.toLowerCase();

  async function considerCandidate(fullPath: string, candidateName: string): Promise<void> {
    if (candidateName.toLowerCase() !== targetName) {
      return;
    }

    try {
      const stat = await fs.stat(fullPath);
      if (stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs;
        bestPath = fullPath;
      }
    } catch {
      // Ignore unreadable files.
    }
  }

  async function walkArtifacts(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[] = [];

    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.resolve(path.join(dir, entry.name));
      if (!isPathWithinRoot(resolvedArtifactsRoot, fullPath)) {
        continue;
      }

      if (entry.isDirectory()) {
        await walkArtifacts(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      await considerCandidate(fullPath, entry.name);
    }
  }

  async function scanWorkspaceRoot(): Promise<void> {
    const fullPath = path.resolve(path.join(resolvedWorkspaceRoot, filename));
    if (!isPathWithinRoot(resolvedWorkspaceRoot, fullPath)) {
      return;
    }

    await considerCandidate(fullPath, path.basename(fullPath));
  }

  await walkArtifacts(resolvedArtifactsRoot);
  await scanWorkspaceRoot();
  return bestPath;
}

export function getBrowserScreenshotAllowedRoots(artifactsRoot: string): [string, string] {
  const resolvedArtifactsRoot = path.resolve(artifactsRoot);
  const resolvedWorkspaceRoot = path.resolve(path.join(resolvedArtifactsRoot, '..'));
  return [resolvedArtifactsRoot, resolvedWorkspaceRoot];
}

export function isPathWithinRoot(rootDir: string, targetPath: string): boolean {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);

  if (resolvedTarget === resolvedRoot) {
    return true;
  }

  return resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}
async function serveStaticAsset(
  res: import('node:http').ServerResponse,
  staticAssetsDir: string,
  requestPath: string,
  headOnly: boolean
): Promise<void> {
  const normalizedPath = sanitizePathname(requestPath);
  const resolvedAssetsDir = path.resolve(staticAssetsDir);

  const tryPaths = normalizedPath === '/'
    ? [path.join(resolvedAssetsDir, 'index.html')]
    : [path.join(resolvedAssetsDir, normalizedPath.slice(1))];

  // SPA fallback for routes without extension.
  if (!path.extname(normalizedPath)) {
    tryPaths.push(path.join(resolvedAssetsDir, 'index.html'));
  }

  for (const filePath of tryPaths) {
    const resolved = path.resolve(filePath);

    if (!resolved.startsWith(resolvedAssetsDir + path.sep) && resolved !== path.join(resolvedAssetsDir, 'index.html')) {
      continue;
    }

    try {
      const stats = await fs.stat(resolved);
      if (!stats.isFile()) {
        continue;
      }

      const contentType = getContentType(resolved);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': getCacheControl(resolved),
      });

      if (headOnly) {
        res.end();
        return;
      }

      const content = await fs.readFile(resolved);
      res.end(content);
      return;
    } catch {
      // Try next path candidate.
    }
  }

  res.writeHead(404);
  res.end('Not Found');
}

function sanitizePathname(input: string): string {
  const decoded = decodeURIComponent(input);
  const normalized = path.posix.normalize(decoded);
  if (!normalized.startsWith('/')) {
    return `/${normalized}`;
  }
  return normalized;
}

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.mjs':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.txt':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function getCacheControl(filePath: string): string {
  const base = path.basename(filePath);
  if (base === 'index.html') {
    return 'no-cache';
  }
  return 'public, max-age=31536000, immutable';
}
