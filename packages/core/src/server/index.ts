import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Gateway } from '../gateway/index.js';
import { normalizeWebMessage, BaseChannel } from '../pipeline/index.js';
import { allBuiltinTools } from '../tools/index.js';
import { updateKeygateFile } from '../config/env.js';
import type {
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
    | 'set_model';
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
}

interface StartWebServerOptions {
  onListening?: () => void | Promise<void>;
  staticAssetsDir?: string;
}

interface DiscordConfigView {
  configured: boolean;
  prefix: string;
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
