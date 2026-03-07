import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Gateway } from '../gateway/index.js';
import type { UsageWindow } from '../usage/index.js';
import { normalizeWebMessage, BaseChannel } from '../pipeline/index.js';
import { updateKeygateFile } from '../config/env.js';
import { MCPBrowserManager, type MCPBrowserStatus } from '../codex/mcpBrowserManager.js';
import {
  buildWhatsAppConfigViewSync,
  cancelActiveWhatsAppLogin,
  getActiveWhatsAppLoginSnapshot,
  normalizeWhatsAppGroupKey,
  normalizeWhatsAppPhoneNumber,
  persistWhatsAppConfig,
  startWhatsAppLogin,
  waitForActiveWhatsAppLoginResult,
  type WhatsAppConfigView,
} from '../whatsapp/index.js';
import {
  loadRegistry,
  searchMarketplace,
  getMarketplaceEntry,
  listFeatured,
  recordDownload,
  type MarketplaceEntry,
} from '../skills/marketplace.js';
import { WebhookService, WebhookStore } from '../webhooks/index.js';
import { RoutingRuleStore, RoutingService } from '../routing/index.js';
import { NodeService, type NodeCapability } from '../nodes/index.js';
import type { NodeInvokeResult } from '../nodes/index.js';
import type {
  BrowserDomainPolicy,
  ChannelType,
  CodexReasoningEffort,
  ConfirmationDecision,
  ConfirmationDetails,
  KeygateConfig,
  MessageAttachment,
  Session,
  SecurityMode,
} from '../types.js';
import {
  IMAGE_UPLOAD_MAX_BYTES,
  cleanupExpiredUploadedImages as cleanupExpiredUploadedImagesFromStore,
  getUploadContentType,
  isUploadPathAllowedForSession,
  normalizeUploadMimeType,
  persistUploadedImage,
  resolveMessageAttachmentRefs,
  resolveUploadPathByAttachmentId as resolveUploadPathByAttachmentIdFromStore,
  sanitizeUploadAttachmentId as sanitizeUploadAttachmentIdFromStore,
  sanitizeUploadSessionId as sanitizeUploadSessionIdFromStore,
  type UploadAttachmentRef,
} from '../attachments/uploadStore.js';
import { GmailAutomationService, type GmailHealthSummary } from '../gmail/index.js';

type WSAttachmentRef = UploadAttachmentRef;

interface WSMessage {
  type:
    | 'message'
    | 'cancel_session'
    | 'get_session_snapshot'
    | 'confirm_response'
    | 'set_mode'
    | 'enable_spicy_mode'
    | 'set_spicy_obedience'
    | 'set_discord_config'
    | 'set_slack_config'
    | 'set_whatsapp_config'
    | 'start_whatsapp_login'
    | 'cancel_whatsapp_login'
    | 'clear_session'
    | 'new_session'
    | 'delete_session'
    | 'delete_all_sessions'
    | 'rename_session'
    | 'switch_session'
    | 'get_models'
    | 'set_model'
    | 'get_mcp_browser_status'
    | 'setup_mcp_browser'
    | 'remove_mcp_browser'
    | 'set_browser_policy'
    | 'plugins_list'
    | 'plugins_info'
    | 'plugins_install'
    | 'plugins_update'
    | 'plugins_remove'
    | 'plugins_enable'
    | 'plugins_disable'
    | 'plugins_reload'
    | 'plugins_set_config'
    | 'plugins_validate'
    | 'plugin_invoke'
    | 'marketplace_search'
    | 'marketplace_info'
    | 'marketplace_featured'
    | 'marketplace_install'
    | 'memory_list'
    | 'memory_get'
    | 'memory_set'
    | 'memory_delete'
    | 'memory_search'
    | 'memory_namespaces'
    | 'memory_vector_search'
    | 'memory_reindex'
    | 'memory_status'
    | 'sessions_list'
    | 'sessions_spawn'
    | 'sessions_history'
    | 'sessions_send'
    | 'usage_summary'
    | 'session_compact'
    | 'debug_events'
    | 'sandbox_list'
    | 'sandbox_explain'
    | 'sandbox_recreate'
    | 'subagents'
    | 'scheduler_list'
    | 'scheduler_create'
    | 'scheduler_update'
    | 'scheduler_delete'
    | 'scheduler_trigger'
    | 'gmail_watch_list'
    | 'gmail_watch_create'
    | 'gmail_watch_update'
    | 'gmail_watch_delete'
    | 'gmail_watch_test'
    | 'webhook_list'
    | 'webhook_create'
    | 'webhook_delete'
    | 'webhook_update'
    | 'webhook_rotate_secret'
    | 'routing_list'
    | 'routing_create'
    | 'routing_delete'
    | 'node_register'
    | 'node_heartbeat'
    | 'node_invoke_response'
    | 'node_pair_request'
    | 'node_pair_pending'
    | 'node_pair_approve'
    | 'node_pair_reject'
    | 'node_list'
    | 'node_describe'
    | 'node_invoke'
    | 'list_slash_commands'
    | 'git_status'
    | 'git_diff'
    | 'git_staged_diff'
    | 'git_log'
    | 'git_file_diff'
    | 'git_stage'
    | 'git_unstage'
    | 'git_discard'
    | 'git_commit';
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
  attachments?: WSAttachmentRef[];
  title?: string;
  botToken?: string;
  appToken?: string;
  signingSecret?: string;
  clearBotToken?: boolean;
  dmPolicy?: 'pairing' | 'open' | 'closed';
  allowFrom?: string[] | string;
  groupMode?: 'closed' | 'selected' | 'open';
  groups?: Record<string, { requireMention?: boolean; name?: string }>;
  groupRequireMentionDefault?: boolean;
  sendReadReceipts?: boolean;
  force?: boolean;
  timeoutSeconds?: number;
  query?: string;
  tags?: string[];
  scope?: string;
  window?: UsageWindow;
  namespace?: string;
  key?: string;
  parentSessionId?: string;
  label?: string;
  limit?: number;
  maxResults?: number;
  minScore?: number;
  action?: 'list' | 'steer' | 'kill';
  cronExpression?: string;
  prompt?: string;
  jobId?: string;
  watchId?: string;
  labelIds?: string[] | string;
  name?: string;
  pluginId?: string;
  method?: string;
  source?: string;
  link?: boolean;
  json?: unknown;
  purge?: boolean;
  promptPrefix?: string;
  secret?: string;
  routeId?: string;
  accountId?: string;
  chatId?: string;
  agentKey?: string;
  ruleId?: string;
  userId?: string;
  requestId?: string;
  pairingCode?: string;
  nodeId?: string;
  authToken?: string;
  capability?: NodeCapability;
  capabilities?: NodeCapability[];
  permissions?: Record<string, 'granted' | 'denied' | 'unknown'>;
  params?: unknown;
  highRiskAck?: boolean;
  nodeName?: string;
  platform?: string;
  version?: string;
  ok?: boolean;
  payload?: Record<string, unknown>;
  message?: string;
  file?: string;
  path?: string;
  staged?: boolean;
  commitMessage?: string;
}

interface StartWebServerOptions {
  onListening?: () => void | Promise<void>;
  staticAssetsDir?: string;
}

export interface WebServerHandle {
  close(): Promise<void>;
}

interface DiscordConfigView {
  configured: boolean;
  prefix: string;
}

interface SlackConfigView {
  configured: boolean;
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
  attachments?: SessionAttachmentView[];
}

interface SessionAttachmentView {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  url: string;
}

interface SessionSnapshotEntryView {
  sessionId: string;
  channelType: ChannelType;
  title?: string;
  updatedAt: string;
  messages: SessionSnapshotMessageView[];
}

const DEFAULT_DISCORD_PREFIX = '!keygate ';
const BROWSER_RETENTION_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const IMAGE_UPLOAD_RETENTION_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const IMAGE_UPLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const WEBHOOK_MAX_BODY_BYTES = 2 * 1024 * 1024;

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

  getSessionId(): string {
    return this.sessionId;
  }

  setSessionId(sessionId: string): void {
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
export function startWebServer(config: KeygateConfig, options: StartWebServerOptions = {}): WebServerHandle {
  const gateway = Gateway.getInstance(config);
  const pluginManager = gateway.plugins;
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

  void cleanupExpiredUploadedImagesFromStore(config.security.workspacePath, IMAGE_UPLOAD_RETENTION_MS).catch((error) => {
    console.warn('Failed initial uploaded image cleanup:', error);
  });

  const uploadCleanupInterval = setInterval(() => {
    void cleanupExpiredUploadedImagesFromStore(config.security.workspacePath, IMAGE_UPLOAD_RETENTION_MS).catch((error) => {
      console.warn('Failed periodic uploaded image cleanup:', error);
    });
  }, IMAGE_UPLOAD_RETENTION_CLEANUP_INTERVAL_MS);

  const webhookService = new WebhookService(new WebhookStore(), async (sessionId, content) => {
    await gateway.sendMessageToSession(sessionId, content, 'webhook:event');
  });
  const gmailService = new GmailAutomationService(config, {
    dispatchToSession: async (sessionId, content) => {
      await gateway.sendMessageToSession(sessionId, content, 'gmail:watch');
    },
  });
  gmailService.start();
  void gmailService.renewDueWatches().catch((error) => {
    console.warn('Initial Gmail watch renewal failed:', error);
  });
  const routingService = new RoutingService(new RoutingRuleStore(), config.security.workspacePath);
  const nodeService = new NodeService();

  const server = createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-keygate-signature');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');

    // Simple REST endpoints
    if (url.pathname === '/api/status') {
      void Promise.allSettled([
        gateway.sandbox.getHealth(),
        nodeService.listNodes(),
        gmailService.getHealth(),
      ]).then((results) => {
        const sandboxHealth = results[0]?.status === 'fulfilled' ? results[0].value : undefined;
        const nodes = results[1]?.status === 'fulfilled' ? results[1].value : undefined;
        const gmailHealth = results[2]?.status === 'fulfilled' ? results[2].value : undefined;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(buildStatusPayload(gateway, config, {
          sandboxHealth,
          nodes,
          gmailHealth,
        })));
      }).catch((error) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'error',
          error: error instanceof Error ? error.message : 'Failed to build status payload',
        }));
      });
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

    if (url.pathname === '/api/uploads/image' && req.method === 'POST') {
      void handleImageUploadRequest(req, res, url, config.security.workspacePath);
      return;
    }

    if (url.pathname === '/api/uploads/image') {
      void serveUploadedImageById(res, req.method, url, config.security.workspacePath);
      return;
    }

    if (url.pathname.startsWith('/api/webhooks/')) {
      const webhookId = url.pathname.slice('/api/webhooks/'.length).trim();
      void handleWebhookInboundRequest(req, res, webhookService, webhookId);
      return;
    }

    if (url.pathname === '/api/gmail/push') {
      void handleGmailPushRequest(req, res, gmailService, url);
      return;
    }

    if (url.pathname.startsWith('/api/plugins/')) {
      void handlePluginHttpRequest(req, res, pluginManager, url);
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
    let webSessionId = `web:${sessionId}`;
    let connectedNodeId: string | null = null;
    const pendingNodeInvokes = new Map<string, {
      resolve: (result: NodeInvokeResult) => void;
      timer: NodeJS.Timeout;
    }>();

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
          case 'node_register': {
            const nodeId = typeof msg.nodeId === 'string' ? msg.nodeId.trim() : '';
            const authToken = typeof msg.authToken === 'string' ? msg.authToken.trim() : '';
            if (!nodeId || !authToken) {
              ws.send(JSON.stringify({ type: 'error', error: 'nodeId and authToken are required' }));
              break;
            }

            const registered = await nodeService.registerNode(
              nodeId,
              authToken,
              {
                platform: typeof msg.platform === 'string' ? msg.platform : undefined,
                version: typeof msg.version === 'string' ? msg.version : undefined,
                permissions: msg.permissions,
              },
              {
                invoke: (request) => new Promise((resolve) => {
                  const requestId = crypto.randomUUID();
                  const timer = setTimeout(() => {
                    pendingNodeInvokes.delete(requestId);
                    resolve({
                      ok: false,
                      nodeId: request.nodeId,
                      capability: request.capability,
                      mode: 'brokered',
                      message: 'Node invocation timed out',
                      deniedReason: 'node_timeout',
                    });
                  }, 30_000);
                  pendingNodeInvokes.set(requestId, { resolve, timer });
                  ws.send(JSON.stringify({
                    type: 'node_invoke_request',
                    requestId,
                    ...request,
                  }));
                }),
              }
            );

            if (!registered) {
              ws.send(JSON.stringify({ type: 'error', error: 'Node authentication failed' }));
              break;
            }

            connectedNodeId = nodeId;
            ws.send(JSON.stringify({ type: 'node_register_result', node: registered }));
            broadcast(wss, { type: 'node_status_changed', nodeId, online: true, lastSeenAt: registered.lastSeenAt });
            break;
          }

          case 'node_heartbeat': {
            const nodeId = typeof msg.nodeId === 'string' ? msg.nodeId.trim() : '';
            const authToken = typeof msg.authToken === 'string' ? msg.authToken.trim() : '';
            if (!nodeId || !authToken) {
              ws.send(JSON.stringify({ type: 'error', error: 'nodeId and authToken are required' }));
              break;
            }

            const updated = await nodeService.heartbeat(nodeId, authToken, {
              platform: typeof msg.platform === 'string' ? msg.platform : undefined,
              version: typeof msg.version === 'string' ? msg.version : undefined,
              permissions: msg.permissions,
            });
            if (!updated) {
              ws.send(JSON.stringify({ type: 'error', error: 'Node heartbeat authentication failed' }));
              break;
            }

            broadcast(wss, { type: 'node_status_changed', nodeId, online: true, lastSeenAt: updated.lastSeenAt });
            break;
          }

          case 'node_invoke_response': {
            const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
            const pending = pendingNodeInvokes.get(requestId);
            if (!pending) {
              break;
            }
            clearTimeout(pending.timer);
            pendingNodeInvokes.delete(requestId);
            pending.resolve({
              ok: msg.ok === true,
              nodeId: typeof msg.nodeId === 'string' ? msg.nodeId : (connectedNodeId ?? 'unknown'),
              capability: isNodeCapability(msg.capability) ? msg.capability : 'invoke',
              mode: 'brokered',
              message: typeof msg.message === 'string' ? msg.message : (msg.ok === true ? 'Node invocation completed' : 'Node invocation failed'),
              deniedReason: typeof msg.source === 'string' ? msg.source : undefined,
              payload: msg.payload,
              params: msg.params,
            });
            break;
          }

          case 'message': {
            const content = typeof msg.content === 'string' ? msg.content.trim() : '';
            let attachments: MessageAttachment[] = [];
            try {
              attachments = await resolveWebMessageAttachments(
                config.security.workspacePath,
                webSessionId,
                msg.attachments
              );
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Invalid image attachments.',
              }));
              break;
            }
            if (!content && attachments.length === 0) {
              return;
            }

            const chatId = extractWebChatId(webSessionId);
            const route = await routingService.resolve({
              channel: 'web',
              chatId,
              userId: 'web-user',
            });
            webSessionId = route.sessionId;
            gateway.setSessionWorkspace(route.sessionId, route.workspacePath);
            channel.setSessionId(webSessionId);

            const activeSession = webSessionId.startsWith('web:') ? webSessionId.slice(4) : webSessionId;
            const normalized = normalizeWebMessage(
              activeSession,
              'web-user',
              content,
              channel,
              attachments.length > 0 ? attachments : undefined
            );

            await gateway.processMessage(normalized);
            break;
          }

          case 'get_session_snapshot': {
            ws.send(JSON.stringify(buildSessionSnapshotPayload(gateway, webSessionId)));
            break;
          }

          case 'cancel_session': {
            const cancelSessionId = typeof msg.sessionId === 'string' && msg.sessionId.trim().length > 0
              ? msg.sessionId.trim()
              : webSessionId;
            gateway.cancelSessionRun(cancelSessionId, 'user');
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

          case 'set_slack_config': {
            try {
              const slack = await applySlackConfigUpdate(
                config,
                {
                  botToken: typeof msg.botToken === 'string' ? msg.botToken : undefined,
                  appToken: typeof msg.appToken === 'string' ? msg.appToken : undefined,
                  signingSecret: typeof msg.signingSecret === 'string' ? msg.signingSecret : undefined,
                  clearBotToken: msg.clearBotToken === true,
                }
              );

              ws.send(JSON.stringify({
                type: 'slack_config_updated',
                slack,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Failed to save Slack configuration',
              }));
            }
            break;
          }

          case 'set_whatsapp_config': {
            try {
              const whatsapp = await applyWhatsAppConfigUpdate(config, {
                dmPolicy: msg.dmPolicy,
                allowFrom: msg.allowFrom,
                groupMode: msg.groupMode,
                groups: msg.groups,
                groupRequireMentionDefault: msg.groupRequireMentionDefault,
                sendReadReceipts: msg.sendReadReceipts,
              });

              ws.send(JSON.stringify({
                type: 'whatsapp_config_updated',
                whatsapp,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Failed to save WhatsApp configuration',
              }));
            }
            break;
          }

          case 'start_whatsapp_login': {
            try {
              const snapshot = await startWhatsAppLogin({
                force: msg.force === true,
                timeoutMs: typeof msg.timeoutSeconds === 'number' && Number.isFinite(msg.timeoutSeconds)
                  ? Math.max(10, msg.timeoutSeconds) * 1000
                  : 120_000,
                onQr: async (qrState) => {
                  ws.send(JSON.stringify({
                    type: 'whatsapp_login_qr',
                    whatsapp: qrState,
                  }));
                },
              });

              const immediate = getActiveWhatsAppLoginSnapshot() ?? snapshot;
              if (immediate.qrDataUrl) {
                ws.send(JSON.stringify({
                  type: 'whatsapp_login_qr',
                  whatsapp: immediate,
                }));
              }

              void waitForActiveWhatsAppLoginResult().then((result) => {
                if (!result) {
                  return;
                }

                ws.send(JSON.stringify({
                  type: 'whatsapp_login_result',
                  result,
                }));
                ws.send(JSON.stringify({
                  type: 'whatsapp_config_updated',
                  whatsapp: buildWhatsAppConfigViewSync(config),
                }));
              });
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Failed to start WhatsApp login',
              }));
            }
            break;
          }

          case 'cancel_whatsapp_login': {
            const result = await cancelActiveWhatsAppLogin();
            ws.send(JSON.stringify({
              type: 'whatsapp_login_result',
              result: result ?? {
                ok: false,
                reason: 'cancelled',
                linkedPhone: null,
                error: 'No active WhatsApp login was running.',
              },
            }));
            break;
          }

          case 'clear_session': {
            gateway.clearSession(webSessionId);
            ws.send(JSON.stringify({ type: 'session_cleared', sessionId }));
            break;
          }

          case 'new_session': {
            const newSession = gateway.createWebSession();
            channel.setSessionId(newSession.id);
            webSessionId = newSession.id;
            ws.send(JSON.stringify({
              type: 'session_created',
              sessionId: newSession.id,
            }));
            ws.send(JSON.stringify(buildSessionSnapshotPayload(gateway, webSessionId)));
            break;
          }

          case 'delete_session': {
            const targetSessionId = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : '';
            if (!targetSessionId) {
              ws.send(JSON.stringify({ type: 'error', error: 'sessionId is required' }));
              break;
            }

            const deletedSessionId = gateway.deleteSession(targetSessionId);

            // If the deleted session was active, switch to another web session or create one.
            if (deletedSessionId === webSessionId) {
              const fallbackWebSession = gateway
                .listSessions()
                .find((session) => session.channelType === 'web');

              const nextSession = fallbackWebSession ?? gateway.createWebSession();
              channel.setSessionId(nextSession.id);
              webSessionId = nextSession.id;
              ws.send(JSON.stringify({
                type: 'session_switched',
                sessionId: nextSession.id,
              }));
            }

            ws.send(JSON.stringify({
              type: 'session_deleted',
              sessionId: deletedSessionId,
            }));
            ws.send(JSON.stringify(buildSessionSnapshotPayload(gateway, webSessionId)));
            break;
          }

          case 'delete_all_sessions': {
            const allSessionIds = gateway.listSessions().map((session) => session.id);
            for (const targetSessionId of allSessionIds) {
              try {
                const deletedSessionId = gateway.deleteSession(targetSessionId);
                ws.send(JSON.stringify({
                  type: 'session_deleted',
                  sessionId: deletedSessionId,
                }));
              } catch {
                // Ignore race/missing session; proceed with best effort.
              }
            }

            const newSession = gateway.createWebSession();
            channel.setSessionId(newSession.id);
            webSessionId = newSession.id;
            ws.send(JSON.stringify({
              type: 'session_created',
              sessionId: newSession.id,
            }));
            ws.send(JSON.stringify({
              type: 'session_switched',
              sessionId: newSession.id,
            }));
            ws.send(JSON.stringify(buildSessionSnapshotPayload(gateway, webSessionId)));
            break;
          }

          case 'rename_session': {
            const renameSessionId = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : '';
            const title = typeof msg.title === 'string' ? msg.title.trim() : '';
            if (!renameSessionId) {
              ws.send(JSON.stringify({ type: 'error', error: 'sessionId is required' }));
              break;
            }

            gateway.renameSession(renameSessionId, title);
            ws.send(JSON.stringify({
              type: 'session_renamed',
              sessionId: renameSessionId,
              title,
            }));
            break;
          }

          case 'switch_session': {
            const switchSessionId = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : '';
            if (!switchSessionId) {
              ws.send(JSON.stringify({ type: 'error', error: 'sessionId is required' }));
              break;
            }

            // Verify session exists (or will be created on first message)
            channel.setSessionId(switchSessionId);
            webSessionId = switchSessionId;
            ws.send(JSON.stringify({
              type: 'session_switched',
              sessionId: switchSessionId,
            }));
            ws.send(JSON.stringify(buildSessionSnapshotPayload(gateway, webSessionId)));
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

          case 'plugins_list': {
            try {
              const plugins = await pluginManager.listPlugins();
              ws.send(JSON.stringify({
                type: 'plugins_list_result',
                plugins,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Plugin listing failed',
              }));
            }
            break;
          }

          case 'plugins_info': {
            const pluginId = typeof msg.pluginId === 'string' ? msg.pluginId.trim() : '';
            if (!pluginId) {
              ws.send(JSON.stringify({ type: 'error', error: 'pluginId is required' }));
              break;
            }

            try {
              const plugin = await pluginManager.getPluginInfo(pluginId);
              ws.send(JSON.stringify({
                type: 'plugins_info_result',
                plugin,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Plugin info failed',
              }));
            }
            break;
          }

          case 'plugins_install': {
            const source = typeof msg.source === 'string' ? msg.source.trim() : '';
            if (!source) {
              ws.send(JSON.stringify({ type: 'error', error: 'source is required' }));
              break;
            }

            try {
              const plugin = await pluginManager.installPlugin({
                source,
                scope: msg.scope === 'global' ? 'global' : 'workspace',
                link: msg.link === true,
              });
              ws.send(JSON.stringify({
                type: 'plugins_install_result',
                plugin,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Plugin install failed',
              }));
            }
            break;
          }

          case 'plugins_update': {
            try {
              const pluginId = typeof msg.pluginId === 'string' ? msg.pluginId.trim() : undefined;
              const plugins = await pluginManager.updatePlugin(pluginId);
              ws.send(JSON.stringify({
                type: 'plugins_update_result',
                plugins,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Plugin update failed',
              }));
            }
            break;
          }

          case 'plugins_remove': {
            const pluginId = typeof msg.pluginId === 'string' ? msg.pluginId.trim() : '';
            if (!pluginId) {
              ws.send(JSON.stringify({ type: 'error', error: 'pluginId is required' }));
              break;
            }

            try {
              const removed = await pluginManager.removePlugin(pluginId, msg.purge === true);
              ws.send(JSON.stringify({
                type: 'plugins_remove_result',
                pluginId,
                removed,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Plugin remove failed',
              }));
            }
            break;
          }

          case 'plugins_enable': {
            const pluginId = typeof msg.pluginId === 'string' ? msg.pluginId.trim() : '';
            if (!pluginId) {
              ws.send(JSON.stringify({ type: 'error', error: 'pluginId is required' }));
              break;
            }

            try {
              const plugin = await pluginManager.enablePlugin(pluginId);
              ws.send(JSON.stringify({
                type: 'plugins_enable_result',
                plugin,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Plugin enable failed',
              }));
            }
            break;
          }

          case 'plugins_disable': {
            const pluginId = typeof msg.pluginId === 'string' ? msg.pluginId.trim() : '';
            if (!pluginId) {
              ws.send(JSON.stringify({ type: 'error', error: 'pluginId is required' }));
              break;
            }

            try {
              const plugin = await pluginManager.disablePlugin(pluginId);
              ws.send(JSON.stringify({
                type: 'plugins_disable_result',
                plugin,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Plugin disable failed',
              }));
            }
            break;
          }

          case 'plugins_reload': {
            try {
              const pluginId = typeof msg.pluginId === 'string' ? msg.pluginId.trim() : undefined;
              const plugins = await pluginManager.reloadPlugin(pluginId);
              ws.send(JSON.stringify({
                type: 'plugins_reload_result',
                plugins,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Plugin reload failed',
              }));
            }
            break;
          }

          case 'plugins_set_config': {
            const pluginId = typeof msg.pluginId === 'string' ? msg.pluginId.trim() : '';
            const json = (msg.json && typeof msg.json === 'object' && !Array.isArray(msg.json))
              ? msg.json as Record<string, unknown>
              : null;

            if (!pluginId || !json) {
              ws.send(JSON.stringify({ type: 'error', error: 'pluginId and json object are required' }));
              break;
            }

            try {
              const plugin = await pluginManager.setPluginConfig(pluginId, json);
              ws.send(JSON.stringify({
                type: 'plugins_set_config_result',
                plugin,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Plugin config update failed',
              }));
            }
            break;
          }

          case 'plugins_validate': {
            const pluginId = typeof msg.pluginId === 'string' ? msg.pluginId.trim() : '';
            if (!pluginId) {
              ws.send(JSON.stringify({ type: 'error', error: 'pluginId is required' }));
              break;
            }

            try {
              const validation = await pluginManager.validatePlugin(pluginId);
              ws.send(JSON.stringify({
                type: 'plugins_validate_result',
                pluginId,
                validation,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Plugin validation failed',
              }));
            }
            break;
          }

          case 'plugin_invoke': {
            const pluginId = typeof msg.pluginId === 'string' ? msg.pluginId.trim() : '';
            const method = typeof msg.method === 'string' ? msg.method.trim() : '';
            const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined;
            if (!pluginId || !method) {
              ws.send(JSON.stringify({ type: 'error', error: 'pluginId and method are required' }));
              break;
            }

            try {
              const result = await pluginManager.invokeRpc(pluginId, method, msg.params);
              ws.send(JSON.stringify({
                type: 'plugin_result',
                pluginId,
                method,
                requestId,
                result,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'plugin_error',
                pluginId,
                method,
                requestId,
                error: sanitizePluginError(error),
              }));
            }
            break;
          }

          case 'marketplace_search': {
            try {
              const query = typeof msg.query === 'string' ? msg.query : '';
              const tags = Array.isArray(msg.tags) ? msg.tags.filter((t): t is string => typeof t === 'string') : [];
              const registry = await loadRegistry();
              const result = searchMarketplace(registry, query, { tags });
              ws.send(JSON.stringify({
                type: 'marketplace_search_result',
                ...result,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Marketplace search failed',
              }));
            }
            break;
          }

          case 'marketplace_info': {
            const name = typeof msg.content === 'string' ? msg.content.trim() : '';
            if (!name) {
              ws.send(JSON.stringify({ type: 'error', error: 'Skill name is required' }));
              break;
            }
            try {
              const registry = await loadRegistry();
              const entry = getMarketplaceEntry(registry, name);
              ws.send(JSON.stringify({
                type: 'marketplace_info_result',
                entry,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Marketplace info failed',
              }));
            }
            break;
          }

          case 'marketplace_featured': {
            try {
              const registry = await loadRegistry();
              const featured = listFeatured(registry);
              ws.send(JSON.stringify({
                type: 'marketplace_featured_result',
                entries: featured,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Marketplace featured failed',
              }));
            }
            break;
          }

          case 'marketplace_install': {
            const name = typeof msg.content === 'string' ? msg.content.trim() : '';
            if (!name) {
              ws.send(JSON.stringify({ type: 'error', error: 'Skill name is required' }));
              break;
            }
            try {
              const registry = await loadRegistry();
              const entry = getMarketplaceEntry(registry, name);
              if (!entry) {
                ws.send(JSON.stringify({ type: 'error', error: `Skill "${name}" not found in marketplace` }));
                break;
              }

              const scope = (typeof msg.scope === 'string' && msg.scope === 'global') ? 'global' : 'workspace';

              // Use the gateway's skills manager to install from the registry source
              const installResult = await installMarketplaceSkill(gateway, entry, scope);
              await recordDownload(name);

              ws.send(JSON.stringify({
                type: 'marketplace_install_result',
                name: entry.name,
                scope,
                installed: installResult,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Marketplace install failed',
              }));
            }
            break;
          }

          case 'memory_list': {
            try {
              const namespace = typeof msg.namespace === 'string' ? msg.namespace : undefined;
              const memories = gateway.memory.list(namespace);
              ws.send(JSON.stringify({
                type: 'memory_list_result',
                memories: memories.map(serializeMemory),
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Memory list failed',
              }));
            }
            break;
          }

          case 'memory_get': {
            const namespace = typeof msg.namespace === 'string' ? msg.namespace : 'general';
            const key = typeof msg.key === 'string' ? msg.key.trim() : '';
            if (!key) {
              ws.send(JSON.stringify({ type: 'error', error: 'Memory key is required' }));
              break;
            }
            try {
              const memory = gateway.memory.get(namespace, key);
              ws.send(JSON.stringify({
                type: 'memory_get_result',
                memory: memory ? serializeMemory(memory) : null,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Memory get failed',
              }));
            }
            break;
          }

          case 'memory_set': {
            const namespace = typeof msg.namespace === 'string' ? msg.namespace : 'general';
            const key = typeof msg.key === 'string' ? msg.key.trim() : '';
            const content = typeof msg.content === 'string' ? msg.content : '';
            if (!key || !content) {
              ws.send(JSON.stringify({ type: 'error', error: 'Memory key and content are required' }));
              break;
            }
            try {
              const memory = gateway.memory.set(namespace, key, content);
              ws.send(JSON.stringify({
                type: 'memory_set_result',
                memory: serializeMemory(memory),
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Memory set failed',
              }));
            }
            break;
          }

          case 'memory_delete': {
            const namespace = typeof msg.namespace === 'string' ? msg.namespace : 'general';
            const key = typeof msg.key === 'string' ? msg.key.trim() : '';
            if (!key) {
              ws.send(JSON.stringify({ type: 'error', error: 'Memory key is required' }));
              break;
            }
            try {
              const deleted = gateway.memory.delete(namespace, key);
              ws.send(JSON.stringify({
                type: 'memory_delete_result',
                key,
                namespace,
                deleted,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Memory delete failed',
              }));
            }
            break;
          }

          case 'memory_search': {
            const query = typeof msg.query === 'string' ? msg.query : '';
            const namespace = typeof msg.namespace === 'string' ? msg.namespace : undefined;
            if (!query) {
              ws.send(JSON.stringify({ type: 'error', error: 'Search query is required' }));
              break;
            }
            try {
              const result = gateway.memory.search(query, { namespace });
              ws.send(JSON.stringify({
                type: 'memory_search_result',
                memories: result.memories.map(serializeMemory),
                total: result.total,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Memory search failed',
              }));
            }
            break;
          }

          case 'memory_namespaces': {
            try {
              const namespaces = gateway.memory.listNamespaces();
              ws.send(JSON.stringify({
                type: 'memory_namespaces_result',
                namespaces,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Memory namespaces failed',
              }));
            }
            break;
          }

          case 'memory_vector_search': {
            const query = typeof msg.query === 'string' ? msg.query : '';
            if (!query) {
              ws.send(JSON.stringify({ type: 'error', error: 'Search query is required' }));
              break;
            }
            try {
              const maxResults = typeof msg.maxResults === 'number' ? msg.maxResults : undefined;
              const minScore = typeof msg.minScore === 'number' ? msg.minScore : undefined;
              const source = typeof msg.source === 'string' ? msg.source as 'memory' | 'session' | 'all' : undefined;
              const results = await gateway.memoryManager.search(query, { maxResults, minScore, source });
              ws.send(JSON.stringify({
                type: 'memory_vector_search_result',
                results,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Vector memory search failed',
              }));
            }
            break;
          }

          case 'memory_reindex': {
            try {
              await gateway.memoryManager.reindex();
              ws.send(JSON.stringify({ type: 'memory_reindex_result', success: true }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Memory reindex failed',
              }));
            }
            break;
          }

          case 'memory_status': {
            try {
              const status = gateway.memoryManager.status();
              ws.send(JSON.stringify({ type: 'memory_status_result', ...status }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Memory status failed',
              }));
            }
            break;
          }

          case 'sessions_list': {
            const parentSessionId = typeof msg.parentSessionId === 'string' ? msg.parentSessionId.trim() : undefined;
            const sessions = gateway.listDelegatedSessions(parentSessionId);
            ws.send(JSON.stringify({
              type: 'sessions_list_result',
              sessions,
            }));
            break;
          }

          case 'sessions_spawn': {
            const parentSessionId = typeof msg.parentSessionId === 'string' && msg.parentSessionId.trim().length > 0
              ? msg.parentSessionId.trim()
              : webSessionId;
            const label = typeof msg.label === 'string' ? msg.label : undefined;
            const spawned = gateway.spawnDelegatedSession(parentSessionId, label);
            ws.send(JSON.stringify({
              type: 'sessions_spawn_result',
              session: spawned,
            }));
            break;
          }

          case 'sessions_history': {
            const targetSessionId = typeof msg.sessionId === 'string' && msg.sessionId.trim().length > 0
              ? msg.sessionId.trim()
              : webSessionId;
            const limit = typeof msg.limit === 'number' ? msg.limit : 50;
            const history = gateway.getSessionHistory(targetSessionId, limit);
            ws.send(JSON.stringify({
              type: 'sessions_history_result',
              sessionId: targetSessionId,
              messages: history,
            }));
            break;
          }

          case 'sessions_send': {
            const targetSessionId = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : '';
            const content = typeof msg.content === 'string' ? msg.content : '';
            if (!targetSessionId || !content.trim()) {
              ws.send(JSON.stringify({ type: 'error', error: 'sessionId and content are required' }));
              break;
            }

            try {
              await gateway.sendMessageToSession(targetSessionId, content);
              ws.send(JSON.stringify({
                type: 'sessions_send_result',
                sessionId: targetSessionId,
                delivered: true,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Failed to send to session',
              }));
            }
            break;
          }

          case 'usage_summary': {
            const window = normalizeUsageWindow(msg.window);
            const targetSessionId = typeof msg.sessionId === 'string' && msg.sessionId.trim().length > 0
              ? msg.sessionId.trim()
              : undefined;
            const summary = gateway.usage.summarize({
              sessionId: targetSessionId,
              window,
            });
            ws.send(JSON.stringify({
              type: 'usage_summary_result',
              summary,
            }));
            break;
          }

          case 'session_compact': {
            const targetSessionId = typeof msg.sessionId === 'string' && msg.sessionId.trim().length > 0
              ? msg.sessionId.trim()
              : webSessionId;
            try {
              const result = await gateway.compactSession(targetSessionId);
              ws.send(JSON.stringify({
                type: 'session_compacted',
                sessionId: targetSessionId,
                compactionSummaryRef: result.ref,
                summary: result.summary,
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Failed to compact session',
              }));
            }
            break;
          }

          case 'debug_events': {
            const targetSessionId = typeof msg.sessionId === 'string' && msg.sessionId.trim().length > 0
              ? msg.sessionId.trim()
              : webSessionId;
            ws.send(JSON.stringify({
              type: 'debug_events_result',
              sessionId: targetSessionId,
              events: gateway.getSessionDebugEvents(targetSessionId),
            }));
            break;
          }

          case 'sandbox_list': {
            const sandboxes = await gateway.sandbox.list();
            ws.send(JSON.stringify({ type: 'sandbox_list_result', sandboxes }));
            break;
          }

          case 'sandbox_explain': {
            const scopeKey = typeof msg.scope === 'string' && msg.scope.trim().length > 0
              ? msg.scope.trim()
              : webSessionId;
            const detail = await gateway.sandbox.explain(scopeKey);
            ws.send(JSON.stringify({ type: 'sandbox_explain_result', detail }));
            break;
          }

          case 'sandbox_recreate': {
            const scopeKey = typeof msg.scope === 'string' && msg.scope.trim().length > 0
              ? msg.scope.trim()
              : webSessionId;
            const workspacePath = gateway.getSessionWorkspace(scopeKey) ?? gateway.config.security.workspacePath;
            try {
              const record = await gateway.sandbox.recreate(scopeKey, workspacePath);
              ws.send(JSON.stringify({ type: 'sandbox_recreate_result', sandbox: record }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Failed to recreate sandbox',
              }));
            }
            break;
          }

          case 'subagents': {
            const action = msg.action;
            if (action === 'list') {
              ws.send(JSON.stringify({
                type: 'subagents_result',
                action,
                sessions: gateway.listDelegatedSessions(),
              }));
              break;
            }

            const targetSessionId = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : '';
            if (!targetSessionId) {
              ws.send(JSON.stringify({ type: 'error', error: 'sessionId is required for this subagents action' }));
              break;
            }

            if (action === 'kill') {
              gateway.killDelegatedSession(targetSessionId, 'user');
              ws.send(JSON.stringify({ type: 'subagents_result', action, sessionId: targetSessionId, ok: true }));
              break;
            }

            if (action === 'steer') {
              const content = typeof msg.content === 'string' ? msg.content : '';
              if (!content.trim()) {
                ws.send(JSON.stringify({ type: 'error', error: 'content is required for subagents steer' }));
                break;
              }

              try {
                await gateway.steerDelegatedSession(targetSessionId, content);
                ws.send(JSON.stringify({ type: 'subagents_result', action, sessionId: targetSessionId, ok: true }));
              } catch (error) {
                ws.send(JSON.stringify({
                  type: 'error',
                  error: error instanceof Error ? error.message : 'Failed to steer subagent',
                }));
              }
              break;
            }

            ws.send(JSON.stringify({ type: 'error', error: 'Unsupported subagents action' }));
            break;
          }

          case 'scheduler_list': {
            const jobs = await gateway.listScheduledJobs();
            ws.send(JSON.stringify({ type: 'scheduler_list_result', jobs }));
            break;
          }

          case 'scheduler_create': {
            const sessionIdValue = typeof msg.sessionId === 'string' && msg.sessionId.trim().length > 0
              ? msg.sessionId.trim()
              : webSessionId;
            const cronExpression = typeof msg.cronExpression === 'string' ? msg.cronExpression : '';
            const prompt = typeof msg.prompt === 'string' ? msg.prompt : '';
            if (!cronExpression.trim() || !prompt.trim()) {
              ws.send(JSON.stringify({ type: 'error', error: 'cronExpression and prompt are required' }));
              break;
            }

            try {
              const job = await gateway.createScheduledJob({
                sessionId: sessionIdValue,
                cronExpression,
                prompt,
                enabled: typeof msg.enabled === 'boolean' ? msg.enabled : true,
              });
              ws.send(JSON.stringify({ type: 'scheduler_create_result', job }));
            } catch (error) {
              ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Failed to create scheduler job' }));
            }
            break;
          }

          case 'scheduler_update': {
            const jobId = typeof msg.jobId === 'string' ? msg.jobId.trim() : '';
            if (!jobId) {
              ws.send(JSON.stringify({ type: 'error', error: 'jobId is required' }));
              break;
            }

            try {
              const job = await gateway.updateScheduledJob(jobId, {
                sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : undefined,
                cronExpression: typeof msg.cronExpression === 'string' ? msg.cronExpression : undefined,
                prompt: typeof msg.prompt === 'string' ? msg.prompt : undefined,
                enabled: typeof msg.enabled === 'boolean' ? msg.enabled : undefined,
              });
              ws.send(JSON.stringify({ type: 'scheduler_update_result', job }));
            } catch (error) {
              ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Failed to update scheduler job' }));
            }
            break;
          }

          case 'scheduler_delete': {
            const jobId = typeof msg.jobId === 'string' ? msg.jobId.trim() : '';
            if (!jobId) {
              ws.send(JSON.stringify({ type: 'error', error: 'jobId is required' }));
              break;
            }

            const deleted = await gateway.deleteScheduledJob(jobId);
            ws.send(JSON.stringify({ type: 'scheduler_delete_result', jobId, deleted }));
            break;
          }

          case 'scheduler_trigger': {
            const jobId = typeof msg.jobId === 'string' ? msg.jobId.trim() : '';
            if (!jobId) {
              ws.send(JSON.stringify({ type: 'error', error: 'jobId is required' }));
              break;
            }

            try {
              const job = await gateway.triggerScheduledJob(jobId);
              ws.send(JSON.stringify({ type: 'scheduler_trigger_result', job }));
            } catch (error) {
              ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Failed to trigger scheduler job' }));
            }
            break;
          }

          case 'gmail_watch_list': {
            const payload = await gmailService.list();
            ws.send(JSON.stringify({ type: 'gmail_watch_list_result', ...payload }));
            break;
          }

          case 'gmail_watch_create': {
            try {
              const payload = await gmailService.createWatch({
                accountId: typeof msg.accountId === 'string' ? msg.accountId.trim() : '',
                targetSessionId:
                  typeof msg.sessionId === 'string' && msg.sessionId.trim().length > 0
                    ? msg.sessionId.trim()
                    : webSessionId,
                labelIds: parseStringList(msg.labelIds),
                promptPrefix: typeof msg.promptPrefix === 'string' ? msg.promptPrefix : undefined,
                enabled: typeof msg.enabled === 'boolean' ? msg.enabled : true,
              });
              ws.send(JSON.stringify({ type: 'gmail_watch_create_result', watch: payload }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Failed to create Gmail watch',
              }));
            }
            break;
          }

          case 'gmail_watch_update': {
            const watchId = typeof msg.watchId === 'string' ? msg.watchId.trim() : '';
            if (!watchId) {
              ws.send(JSON.stringify({ type: 'error', error: 'watchId is required' }));
              break;
            }

            try {
              const watch = await gmailService.updateWatch(watchId, {
                targetSessionId: typeof msg.sessionId === 'string' ? msg.sessionId : undefined,
                labelIds: msg.labelIds === undefined ? undefined : parseStringList(msg.labelIds),
                promptPrefix: typeof msg.promptPrefix === 'string' ? msg.promptPrefix : undefined,
                enabled: typeof msg.enabled === 'boolean' ? msg.enabled : undefined,
              });
              ws.send(JSON.stringify({ type: 'gmail_watch_update_result', watch }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Failed to update Gmail watch',
              }));
            }
            break;
          }

          case 'gmail_watch_delete': {
            const watchId = typeof msg.watchId === 'string' ? msg.watchId.trim() : '';
            if (!watchId) {
              ws.send(JSON.stringify({ type: 'error', error: 'watchId is required' }));
              break;
            }

            const deleted = await gmailService.deleteWatch(watchId);
            ws.send(JSON.stringify({ type: 'gmail_watch_delete_result', watchId, deleted }));
            break;
          }

          case 'gmail_watch_test': {
            const watchId = typeof msg.watchId === 'string' ? msg.watchId.trim() : '';
            if (!watchId) {
              ws.send(JSON.stringify({ type: 'error', error: 'watchId is required' }));
              break;
            }

            try {
              const result = await gmailService.testWatch(watchId);
              ws.send(JSON.stringify({ type: 'gmail_watch_test_result', watchId, result }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Failed to test Gmail watch',
              }));
            }
            break;
          }

          case 'webhook_list': {
            const routes = await webhookService.listRoutes();
            ws.send(JSON.stringify({ type: 'webhook_list_result', routes }));
            break;
          }

          case 'webhook_create': {
            const name = typeof msg.name === 'string' ? msg.name : '';
            const sessionIdValue = typeof msg.sessionId === 'string' && msg.sessionId.trim().length > 0
              ? msg.sessionId.trim()
              : webSessionId;
            if (!name.trim()) {
              ws.send(JSON.stringify({ type: 'error', error: 'name is required' }));
              break;
            }

            try {
              const route = await webhookService.createRoute({
                name,
                sessionId: sessionIdValue,
                promptPrefix: typeof msg.promptPrefix === 'string' ? msg.promptPrefix : undefined,
                enabled: typeof msg.enabled === 'boolean' ? msg.enabled : true,
                secret: typeof msg.secret === 'string' ? msg.secret : undefined,
              });
              ws.send(JSON.stringify({ type: 'webhook_create_result', route }));
            } catch (error) {
              ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Failed to create webhook route' }));
            }
            break;
          }

          case 'webhook_delete': {
            const routeId = typeof msg.routeId === 'string' ? msg.routeId.trim() : '';
            if (!routeId) {
              ws.send(JSON.stringify({ type: 'error', error: 'routeId is required' }));
              break;
            }

            const deleted = await webhookService.deleteRoute(routeId);
            ws.send(JSON.stringify({ type: 'webhook_delete_result', routeId, deleted }));
            break;
          }

          case 'webhook_update': {
            const routeId = typeof msg.routeId === 'string' ? msg.routeId.trim() : '';
            if (!routeId) {
              ws.send(JSON.stringify({ type: 'error', error: 'routeId is required' }));
              break;
            }

            try {
              const route = await webhookService.updateRoute(routeId, {
                sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : undefined,
                promptPrefix: typeof msg.promptPrefix === 'string' ? msg.promptPrefix : undefined,
                enabled: typeof msg.enabled === 'boolean' ? msg.enabled : undefined,
              });
              ws.send(JSON.stringify({ type: 'webhook_update_result', route }));
            } catch (error) {
              ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Failed to update webhook route' }));
            }
            break;
          }

          case 'webhook_rotate_secret': {
            const routeId = typeof msg.routeId === 'string' ? msg.routeId.trim() : '';
            if (!routeId) {
              ws.send(JSON.stringify({ type: 'error', error: 'routeId is required' }));
              break;
            }

            try {
              const route = await webhookService.rotateSecret(routeId);
              ws.send(JSON.stringify({ type: 'webhook_rotate_secret_result', route }));
            } catch (error) {
              ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Failed to rotate webhook secret' }));
            }
            break;
          }

          case 'routing_list': {
            const rules = await routingService.listRules();
            ws.send(JSON.stringify({ type: 'routing_list_result', rules }));
            break;
          }

          case 'routing_create': {
            const agentKey = typeof msg.agentKey === 'string' ? msg.agentKey : '';
            const chatId = typeof msg.chatId === 'string' ? msg.chatId : undefined;
            const userId = typeof msg.userId === 'string' ? msg.userId : undefined;
            const accountId = typeof msg.accountId === 'string' ? msg.accountId : undefined;
            const channel = typeof msg.scope === 'string' ? msg.scope : '*';

            if (!agentKey.trim()) {
              ws.send(JSON.stringify({ type: 'error', error: 'agentKey is required' }));
              break;
            }

            try {
              const rule = await routingService.createRule({
                channel: (channel === '*' || channel === 'web' || channel === 'discord' || channel === 'slack' || channel === 'terminal')
                  ? channel
                  : '*',
                accountId,
                chatId,
                userId,
                agentKey,
              });
              ws.send(JSON.stringify({ type: 'routing_create_result', rule }));
            } catch (error) {
              ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Failed to create routing rule' }));
            }
            break;
          }

          case 'routing_delete': {
            const ruleId = typeof msg.ruleId === 'string' ? msg.ruleId.trim() : '';
            if (!ruleId) {
              ws.send(JSON.stringify({ type: 'error', error: 'ruleId is required' }));
              break;
            }

            const deleted = await routingService.deleteRule(ruleId);
            ws.send(JSON.stringify({ type: 'routing_delete_result', ruleId, deleted }));
            break;
          }

          case 'node_pair_request': {
            const nodeName = typeof msg.nodeName === 'string' ? msg.nodeName : 'Node';
            const capabilities = Array.isArray(msg.capabilities) ? msg.capabilities.filter(isNodeCapability) : [];
            try {
              const request = await nodeService.requestPairing(nodeName, capabilities);
              ws.send(JSON.stringify({ type: 'node_pair_request_result', request }));
            } catch (error) {
              ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Failed to create pair request' }));
            }
            break;
          }

          case 'node_pair_pending': {
            const pending = await nodeService.listPendingPairings();
            ws.send(JSON.stringify({ type: 'node_pair_pending_result', pending }));
            break;
          }

          case 'node_pair_approve': {
            const requestId = typeof msg.requestId === 'string' ? msg.requestId.trim() : '';
            const pairingCode = typeof msg.pairingCode === 'string' ? msg.pairingCode.trim() : '';
            if (!requestId || !pairingCode) {
              ws.send(JSON.stringify({ type: 'error', error: 'requestId and pairingCode are required' }));
              break;
            }

            try {
              const node = await nodeService.approvePairing(requestId, pairingCode);
              ws.send(JSON.stringify({ type: 'node_pair_approve_result', node }));
            } catch (error) {
              ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Failed to approve pair request' }));
            }
            break;
          }

          case 'node_pair_reject': {
            const requestId = typeof msg.requestId === 'string' ? msg.requestId.trim() : '';
            if (!requestId) {
              ws.send(JSON.stringify({ type: 'error', error: 'requestId is required' }));
              break;
            }

            const rejected = await nodeService.rejectPairing(requestId);
            ws.send(JSON.stringify({ type: 'node_pair_reject_result', requestId, rejected }));
            break;
          }

          case 'node_list': {
            const nodes = await nodeService.listNodes();
            ws.send(JSON.stringify({ type: 'node_list_result', nodes }));
            break;
          }

          case 'node_describe': {
            const nodeId = typeof msg.nodeId === 'string' ? msg.nodeId.trim() : '';
            if (!nodeId) {
              ws.send(JSON.stringify({ type: 'error', error: 'nodeId is required' }));
              break;
            }

            const node = await nodeService.describeNode(nodeId);
            ws.send(JSON.stringify({ type: 'node_describe_result', node }));
            break;
          }

          case 'node_invoke': {
            const nodeId = typeof msg.nodeId === 'string' ? msg.nodeId.trim() : '';
            const capability = isNodeCapability(msg.capability) ? msg.capability : null;
            if (!nodeId || !capability) {
              ws.send(JSON.stringify({ type: 'error', error: 'nodeId and valid capability are required' }));
              break;
            }

            const params = (msg.params && typeof msg.params === 'object')
              ? { ...(msg.params as Record<string, unknown>), highRiskAck: msg.highRiskAck === true }
              : { highRiskAck: msg.highRiskAck === true };

            const result = await nodeService.invokeNode(nodeId, capability, params);
            ws.send(JSON.stringify({ type: 'node_invoke_result', result }));
            break;
          }

          case 'list_slash_commands': {
            try {
              const builtinCommands = [
                { command: 'help', description: 'Show available commands.', source: 'builtin' as const },
                { command: 'status', description: 'Show current model, tokens, and session state.', source: 'builtin' as const },
                { command: 'model', description: 'Show or set the session model override.', source: 'builtin' as const },
                { command: 'compact', description: 'Summarize the session and keep a short recent tail.', source: 'builtin' as const },
                { command: 'debug', description: 'Show or toggle the session debug buffer.', source: 'builtin' as const },
                { command: 'stop', description: 'Cancel the active run for this session.', source: 'builtin' as const },
                { command: 'new', description: 'Start a fresh session in the current thread.', source: 'builtin' as const },
                { command: 'reset', description: 'Reset the session history and local overrides.', source: 'builtin' as const },
              ];

              let skillCommands: { command: string; description: string; source: 'skill' }[] = [];
              try {
                const entries = await gateway.skills.listSkills(webSessionId);
                skillCommands = entries
                  .filter((entry) => entry.skill.userInvocable)
                  .map((entry) => ({
                    command: entry.skill.name.toLowerCase(),
                    description: entry.skill.description.split('\n')[0] ?? entry.skill.description,
                    source: 'skill' as const,
                  }))
                  .sort((a, b) => a.command.localeCompare(b.command));
              } catch {
                // Skills may not be ready yet
              }

              ws.send(JSON.stringify({
                type: 'slash_commands_result',
                commands: [...builtinCommands, ...skillCommands],
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : 'Failed to list slash commands',
              }));
            }
            break;
          }

          // ==================== Git ====================

          case 'git_status': {
            try {
              const cwd = gateway.getSessionWorkspace(webSessionId) ?? gateway.config.security.workspacePath;
              const state = await gateway.git.getStatus(cwd);
              ws.send(JSON.stringify({ type: 'git_status_result', state }));
            } catch (error) {
              ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'git_status failed' }));
            }
            break;
          }

          case 'git_diff': {
            try {
              const cwd = gateway.getSessionWorkspace(webSessionId) ?? gateway.config.security.workspacePath;
              const diffs = await gateway.git.getDiff(cwd);
              ws.send(JSON.stringify({ type: 'git_diff_result', diffs }));
            } catch (error) {
              ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'git_diff failed' }));
            }
            break;
          }

          case 'git_staged_diff': {
            try {
              const cwd = gateway.getSessionWorkspace(webSessionId) ?? gateway.config.security.workspacePath;
              const diffs = await gateway.git.getStagedDiff(cwd);
              ws.send(JSON.stringify({ type: 'git_staged_diff_result', diffs }));
            } catch (error) {
              ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'git_staged_diff failed' }));
            }
            break;
          }

          case 'git_log': {
            try {
              const cwd = gateway.getSessionWorkspace(webSessionId) ?? gateway.config.security.workspacePath;
              const limit = typeof msg.limit === 'number' ? msg.limit : 20;
              const commits = await gateway.git.getLog(cwd, limit);
              ws.send(JSON.stringify({ type: 'git_log_result', commits }));
            } catch (error) {
              ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'git_log failed' }));
            }
            break;
          }

          case 'git_file_diff': {
            try {
              const filePath = typeof msg.path === 'string' ? msg.path : '';
              if (!filePath) { ws.send(JSON.stringify({ type: 'error', error: 'path is required' })); break; }
              const cwd = gateway.getSessionWorkspace(webSessionId) ?? gateway.config.security.workspacePath;
              const diff = await gateway.git.getFileDiff(cwd, filePath);
              ws.send(JSON.stringify({ type: 'git_file_diff_result', diff }));
            } catch (error) {
              ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'git_file_diff failed' }));
            }
            break;
          }

          case 'git_stage': {
            try {
              const filePath = typeof msg.path === 'string' ? msg.path : '';
              if (!filePath) { ws.send(JSON.stringify({ type: 'error', error: 'path is required' })); break; }
              const cwd = gateway.getSessionWorkspace(webSessionId) ?? gateway.config.security.workspacePath;
              await gateway.git.stage(cwd, filePath);
              const state = await gateway.git.getStatus(cwd);
              ws.send(JSON.stringify({ type: 'git_status_result', state }));
            } catch (error) {
              ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'git_stage failed' }));
            }
            break;
          }

          case 'git_unstage': {
            try {
              const filePath = typeof msg.path === 'string' ? msg.path : '';
              if (!filePath) { ws.send(JSON.stringify({ type: 'error', error: 'path is required' })); break; }
              const cwd = gateway.getSessionWorkspace(webSessionId) ?? gateway.config.security.workspacePath;
              await gateway.git.unstage(cwd, filePath);
              const state = await gateway.git.getStatus(cwd);
              ws.send(JSON.stringify({ type: 'git_status_result', state }));
            } catch (error) {
              ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'git_unstage failed' }));
            }
            break;
          }

          case 'git_discard': {
            try {
              const filePath = typeof msg.path === 'string' ? msg.path : '';
              if (!filePath) { ws.send(JSON.stringify({ type: 'error', error: 'path is required' })); break; }
              const cwd = gateway.getSessionWorkspace(webSessionId) ?? gateway.config.security.workspacePath;
              await gateway.git.discard(cwd, filePath);
              const state = await gateway.git.getStatus(cwd);
              ws.send(JSON.stringify({ type: 'git_status_result', state }));
            } catch (error) {
              ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'git_discard failed' }));
            }
            break;
          }

          case 'git_commit': {
            try {
              const commitMessage = typeof msg.commitMessage === 'string' ? msg.commitMessage.trim() : '';
              if (!commitMessage) { ws.send(JSON.stringify({ type: 'error', error: 'commitMessage is required' })); break; }
              const cwd = gateway.getSessionWorkspace(webSessionId) ?? gateway.config.security.workspacePath;
              const result = await gateway.git.commit(cwd, commitMessage);
              const state = await gateway.git.getStatus(cwd);
              ws.send(JSON.stringify({ type: 'git_commit_result', result, state }));
            } catch (error) {
              ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'git_commit failed' }));
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
      for (const pending of pendingNodeInvokes.values()) {
        clearTimeout(pending.timer);
        pending.resolve({
          ok: false,
          nodeId: connectedNodeId ?? 'unknown',
          capability: 'invoke',
          mode: 'brokered',
          message: 'Node connection closed',
          deniedReason: 'node_disconnected',
        });
      }
      pendingNodeInvokes.clear();
      if (connectedNodeId) {
        void nodeService.disconnectNode(connectedNodeId).then(() => {
          broadcast(wss, {
            type: 'node_status_changed',
            nodeId: connectedNodeId,
            online: false,
            lastSeenAt: new Date().toISOString(),
          });
        });
      }
      gateway.cancelSessionRun(webSessionId, 'disconnect');
      channel.handleDisconnect();
      console.log(`Client disconnected: ${sessionId}`);
      channels.delete(sessionId);
    });
  });

  // Forward gateway events to all connected clients
  gateway.on('message:user', (event) => {
    broadcast(wss, buildSessionUserMessagePayload(event));
  });

  gateway.on('message:start', (event) => {
    broadcast(wss, { type: 'message_received', sessionId: event.sessionId });
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

    // Auto-push git status after filesystem/shell tool completes
    const toolType = (event as Record<string, unknown>)['toolType'] as string | undefined;
    const sid = (event as Record<string, unknown>)['sessionId'] as string | undefined;
    if (sid && (toolType === 'filesystem' || toolType === 'shell' || toolType === 'other')) {
      const cwd = gateway.getSessionWorkspace(sid) ?? gateway.config.security.workspacePath;
      void gateway.git.getStatus(cwd).then((state) => {
        if (state.isRepo) {
          broadcast(wss, { type: 'git_status_result', state, sessionId: sid });
        }
      }).catch(() => { /* ignore git status errors on auto-push */ });
    }
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

  gateway.on('context:usage', (event) => {
    broadcast(wss, { type: 'context_usage', ...event });
  });

  gateway.on('usage:snapshot', (event) => {
    broadcast(wss, { type: 'usage_snapshot', ...event });
  });

  gateway.on('session:compacted', (event) => {
    broadcast(wss, { type: 'session_compacted', ...event });
  });

  gateway.on('session:cancelled', (event) => {
    broadcast(wss, { type: 'session_cancelled', ...event });
  });

  gateway.on('debug:event', (event) => {
    broadcast(wss, { type: 'debug_event', ...event });
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
    clearInterval(uploadCleanupInterval);
    gmailService.stop();
  });

  return {
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        for (const client of wss.clients) {
          client.close();
        }

        wss.close(() => {
          server.close(() => {
            Gateway.reset();
            resolve();
          });
        });
      });
    },
  };
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

export function buildStatusPayload(
  gateway: Gateway,
  config: KeygateConfig,
  extras: {
    sandboxHealth?: { available: boolean; detail: string; image: string; scope: string };
    nodes?: Array<{ online?: boolean }>;
    gmailHealth?: GmailHealthSummary;
  } = {}
): Record<string, unknown> {
  const skills = typeof (gateway as Partial<Gateway>).getSkillsStatus === 'function'
    ? gateway.getSkillsStatus()
    : { loadedCount: 0, eligibleCount: 0, snapshotVersion: 'empty' };
  const usage = typeof (gateway as Partial<Gateway> & { usage?: { summarize?: (options: { window: UsageWindow }) => unknown } }).usage?.summarize === 'function'
    ? gateway.usage.summarize({ window: '30d' })
    : {
      window: '30d',
      generatedAt: new Date().toISOString(),
      total: { key: 'total', turns: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: 0 },
      byProvider: [],
      byModel: [],
      bySession: [],
      byDay: [],
    };
  return {
    status: 'ok',
    mode: gateway.getSecurityMode(),
    spicyEnabled: gateway.getSpicyModeEnabled(),
    spicyObedienceEnabled: gateway.getSpicyMaxObedienceEnabled(),
    llm: gateway.getLLMState(),
    discord: buildDiscordConfigView(config),
    slack: buildSlackConfigView(config),
    whatsapp: buildWhatsAppConfigViewSync(config),
    browser: buildBrowserConfigViewFromConfig(config),
    skills,
    usage,
    sandbox: extras.sandboxHealth
      ? {
        available: extras.sandboxHealth.available,
        detail: extras.sandboxHealth.detail,
        image: extras.sandboxHealth.image,
        scope: extras.sandboxHealth.scope,
      }
      : {
        available: false,
        detail: 'unavailable',
        image: config.security?.sandbox?.image ?? 'unknown',
        scope: config.security?.sandbox?.scope ?? 'session',
      },
    nodes: extras.nodes
      ? {
        total: extras.nodes.length,
        online: extras.nodes.filter((node) => node.online === true).length,
      }
      : {
        total: 0,
        online: 0,
      },
    gmail: extras.gmailHealth ?? {
      accounts: 0,
      watches: 0,
      enabledWatches: 0,
      expiredWatches: 0,
      dueForRenewal: 0,
    },
  };
}

export function buildConnectedPayload(
  sessionId: string,
  gateway: Gateway,
  llmState: ReturnType<Gateway['getLLMState']>,
  config: KeygateConfig
): Record<string, unknown> {
  const skills = typeof (gateway as Partial<Gateway>).getSkillsStatus === 'function'
    ? gateway.getSkillsStatus(`web:${sessionId}`)
    : { loadedCount: 0, eligibleCount: 0, snapshotVersion: 'empty' };
  return {
    type: 'connected',
    sessionId,
    mode: gateway.getSecurityMode(),
    spicyEnabled: gateway.getSpicyModeEnabled(),
    spicyObedienceEnabled: gateway.getSpicyMaxObedienceEnabled(),
    llm: llmState,
    discord: buildDiscordConfigView(config),
    slack: buildSlackConfigView(config),
    whatsapp: buildWhatsAppConfigViewSync(config),
    browser: buildBrowserConfigViewFromConfig(config),
    skills,
  };
}

export function buildSessionSnapshotPayload(
  gateway: Gateway,
  webSessionId: string
): Record<string, unknown> {
  const sessions = gateway.listSessions();
  const visibleSessions = sessions.filter((session) => (
    session.channelType === 'web' ||
    session.channelType === 'discord' ||
    session.channelType === 'terminal' ||
    session.channelType === 'slack' ||
    session.channelType === 'whatsapp'
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
  attachments?: MessageAttachment[];
}): Record<string, unknown> {
  const attachments = mapAttachmentsForTransport(event.attachments);
  return {
    type: 'session_user_message',
    sessionId: event.sessionId,
    channelType: event.channelType,
    content: event.content,
    ...(attachments ? { attachments } : {}),
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

function parseStringList(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(
      value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0)
    ));
  }

  if (typeof value !== 'string') {
    return [];
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
    title: session.title,
    updatedAt: session.updatedAt.toISOString(),
    messages: session.messages
      .filter((message): message is Session['messages'][number] & { role: 'user' | 'assistant' } => (
        message.role === 'user' || message.role === 'assistant'
      ))
      .map((message) => {
        const attachments = mapAttachmentsForTransport(message.attachments);
        return {
          role: message.role,
          content: message.content,
          ...(attachments ? { attachments } : {}),
        };
      }),
  };
}

function mapAttachmentsForTransport(attachments: MessageAttachment[] | undefined): SessionAttachmentView[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  return attachments.map((attachment) => ({
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    url: attachment.url,
  }));
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

function normalizeUsageWindow(value: unknown): UsageWindow {
  if (value === '24h' || value === '7d' || value === '30d' || value === 'all') {
    return value;
  }

  return '30d';
}

function buildDiscordConfigView(config: KeygateConfig): DiscordConfigView {
  const token = (config.discord?.token ?? process.env['DISCORD_TOKEN'] ?? '').trim();
  const prefix = normalizeDiscordPrefix(config.discord?.prefix ?? process.env['DISCORD_PREFIX']);

  return {
    configured: token.length > 0,
    prefix,
  };
}

function serializeMemory(memory: { id: number; namespace: string; key: string; content: string; createdAt: Date; updatedAt: Date }) {
  return {
    id: memory.id,
    namespace: memory.namespace,
    key: memory.key,
    content: memory.content,
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
  };
}

async function installMarketplaceSkill(
  gateway: Gateway,
  entry: MarketplaceEntry,
  scope: 'workspace' | 'global'
): Promise<boolean> {
  const manager = gateway.skills;
  await manager.ensureReady();
  const targetRoot = manager.getScopeRoot(scope);

  // Import needed modules
  const { promises: fsPromises } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const pathMod = await import('node:path');

  const source = entry.source;
  let sourcePath: string;
  let cleanup: (() => Promise<void>) | undefined;

  const resolvedLocal = pathMod.default.resolve(source);
  try {
    const stat = await fsPromises.stat(resolvedLocal);
    if (stat.isDirectory()) {
      sourcePath = resolvedLocal;
    } else {
      throw new Error('not a directory');
    }
  } catch {
    // Try git clone
    const tempDir = await fsPromises.mkdtemp(pathMod.default.join(os.default.tmpdir(), 'keygate-mp-install-'));
    const cloneResult = spawnSync('git', ['clone', '--depth', '1', source, tempDir], { encoding: 'utf8' });
    if (cloneResult.status !== 0) {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
      throw new Error(`Failed to clone source: ${(cloneResult.stderr || '').trim()}`);
    }
    sourcePath = tempDir;
    cleanup = async () => { await fsPromises.rm(tempDir, { recursive: true, force: true }); };
  }

  try {
    const skillDir = pathMod.default.join(sourcePath, entry.name);
    let fromDir: string;
    try {
      await fsPromises.access(pathMod.default.join(skillDir, 'SKILL.md'));
      fromDir = skillDir;
    } catch {
      fromDir = sourcePath;
    }

    const targetDir = pathMod.default.join(targetRoot, entry.name);
    await fsPromises.mkdir(targetRoot, { recursive: true });
    await fsPromises.rm(targetDir, { recursive: true, force: true });
    await fsPromises.cp(fromDir, targetDir, { recursive: true });

    const state = await manager.loadInstallState(scope);
    state.records[entry.name] = {
      name: entry.name,
      source: entry.source,
      scope,
      installedAt: new Date().toISOString(),
    };
    await manager.saveInstallState(scope, state);
    await manager.refresh();

    return true;
  } finally {
    if (cleanup) {
      await cleanup();
    }
  }
}

function buildSlackConfigView(config: KeygateConfig): SlackConfigView {
  const botToken = (config.slack?.botToken ?? process.env['SLACK_BOT_TOKEN'] ?? '').trim();

  return {
    configured: botToken.length > 0,
  };
}

export async function applySlackConfigUpdate(
  config: KeygateConfig,
  update: {
    botToken?: string;
    appToken?: string;
    signingSecret?: string;
    clearBotToken?: boolean;
  },
  persistConfigUpdate: typeof updateKeygateFile = updateKeygateFile
): Promise<SlackConfigView> {
  const currentBotToken = config.slack?.botToken ?? process.env['SLACK_BOT_TOKEN'] ?? '';
  const currentAppToken = config.slack?.appToken ?? process.env['SLACK_APP_TOKEN'] ?? '';
  const currentSigningSecret = config.slack?.signingSecret ?? process.env['SLACK_SIGNING_SECRET'] ?? '';

  const hasBotTokenUpdate = typeof update.botToken === 'string' && update.botToken.trim().length > 0;
  const hasAppTokenUpdate = typeof update.appToken === 'string' && update.appToken.trim().length > 0;
  const hasSigningSecretUpdate = typeof update.signingSecret === 'string' && update.signingSecret.trim().length > 0;
  const shouldClear = update.clearBotToken === true;

  const nextBotToken = shouldClear ? '' : hasBotTokenUpdate ? update.botToken!.trim() : currentBotToken;
  const nextAppToken = shouldClear ? '' : hasAppTokenUpdate ? update.appToken!.trim() : currentAppToken;
  const nextSigningSecret = shouldClear ? '' : hasSigningSecretUpdate ? update.signingSecret!.trim() : currentSigningSecret;

  const envUpdates: Record<string, string> = {};
  if (hasBotTokenUpdate || shouldClear) {
    envUpdates['SLACK_BOT_TOKEN'] = nextBotToken;
  }
  if (hasAppTokenUpdate || shouldClear) {
    envUpdates['SLACK_APP_TOKEN'] = nextAppToken;
  }
  if (hasSigningSecretUpdate || shouldClear) {
    envUpdates['SLACK_SIGNING_SECRET'] = nextSigningSecret;
  }

  if (Object.keys(envUpdates).length > 0) {
    await persistConfigUpdate(envUpdates);
  }

  const existingSlack = config.slack ?? { botToken: currentBotToken, appToken: currentAppToken, signingSecret: currentSigningSecret };
  existingSlack.botToken = nextBotToken;
  existingSlack.appToken = nextAppToken;
  existingSlack.signingSecret = nextSigningSecret;
  config.slack = existingSlack;

  process.env['SLACK_BOT_TOKEN'] = nextBotToken;
  process.env['SLACK_APP_TOKEN'] = nextAppToken;
  process.env['SLACK_SIGNING_SECRET'] = nextSigningSecret;

  return buildSlackConfigView(config);
}

export async function applyWhatsAppConfigUpdate(
  config: KeygateConfig,
  update: {
    dmPolicy?: 'pairing' | 'open' | 'closed';
    allowFrom?: string[] | string;
    groupMode?: 'closed' | 'selected' | 'open';
    groups?: Record<string, { requireMention?: boolean; name?: string }>;
    groupRequireMentionDefault?: boolean;
    sendReadReceipts?: boolean;
  },
  persistConfig: typeof persistWhatsAppConfig = persistWhatsAppConfig,
): Promise<WhatsAppConfigView> {
  const current = buildWhatsAppConfigViewSync(config);
  const nextDmPolicy = update.dmPolicy ?? current.dmPolicy;
  if (nextDmPolicy !== 'pairing' && nextDmPolicy !== 'open' && nextDmPolicy !== 'closed') {
    throw new Error('WhatsApp DM policy must be pairing, open, or closed.');
  }

  const nextGroupMode = update.groupMode ?? current.groupMode;
  if (nextGroupMode !== 'closed' && nextGroupMode !== 'selected' && nextGroupMode !== 'open') {
    throw new Error('WhatsApp group mode must be closed, selected, or open.');
  }

  const nextAllowFrom = normalizeWhatsAppAllowlist(update.allowFrom ?? current.allowFrom);
  const nextGroups = normalizeWhatsAppGroupRules(update.groups ?? current.groups);

  const persisted = await persistConfig({
    dmPolicy: nextDmPolicy,
    allowFrom: nextAllowFrom,
    groupMode: nextGroupMode,
    groups: nextGroups,
    groupRequireMentionDefault:
      typeof update.groupRequireMentionDefault === 'boolean'
        ? update.groupRequireMentionDefault
        : current.groupRequireMentionDefault,
    sendReadReceipts:
      typeof update.sendReadReceipts === 'boolean'
        ? update.sendReadReceipts
        : current.sendReadReceipts,
  });

  config.whatsapp = persisted;
  return buildWhatsAppConfigViewSync(config);
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

function normalizeWhatsAppAllowlist(value: string[] | string): string[] {
  const entries = Array.isArray(value)
    ? value
    : value.split(',').map((entry) => entry.trim());

  const normalized: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === '*') {
      normalized.push('*');
      continue;
    }

    const phoneNumber = normalizeWhatsAppPhoneNumber(trimmed);
    if (!phoneNumber) {
      throw new Error(`Invalid WhatsApp allow-from entry: ${trimmed}`);
    }
    normalized.push(phoneNumber);
  }

  return Array.from(new Set(normalized));
}

function normalizeWhatsAppGroupRules(
  value: Record<string, { requireMention?: boolean; name?: string }>
): Record<string, { requireMention?: boolean; name?: string }> {
  const normalized: Record<string, { requireMention?: boolean; name?: string }> = {};
  for (const [key, rule] of Object.entries(value)) {
    const groupKey = normalizeWhatsAppGroupKey(key);
    if (!groupKey || groupKey !== key.trim()) {
      throw new Error(`Invalid WhatsApp group key: ${key}`);
    }

    normalized[groupKey] = {
      requireMention: typeof rule?.requireMention === 'boolean' ? rule.requireMention : undefined,
      name: typeof rule?.name === 'string' && rule.name.trim().length > 0 ? rule.name.trim() : undefined,
    };
  }

  return normalized;
}

export async function handleImageUploadRequest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  url: URL,
  workspacePath: string
): Promise<void> {
  const sessionId = sanitizeUploadSessionId(url.searchParams.get('sessionId'));
  if (!sessionId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Valid sessionId query parameter is required.' }));
    return;
  }

  const contentType = normalizeUploadMimeType(req.headers['content-type']);

  let body: Buffer;
  try {
    body = await readRequestBody(req, IMAGE_UPLOAD_MAX_BYTES);
  } catch (error) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: error instanceof Error ? error.message : 'Image payload exceeds the allowed size.',
    }));
    return;
  }

  let attachment: MessageAttachment;
  try {
    attachment = await persistUploadedImage(workspacePath, sessionId, {
      bytes: body,
      contentType,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Image upload failed.';
    const statusCode = message.includes('supported') ? 415 : 400;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(mapUploadedAttachmentForTransport(attachment)));
}

export async function serveUploadedImageById(
  res: import('node:http').ServerResponse,
  method: string | undefined,
  url: URL,
  workspacePath: string
): Promise<void> {
  if (method && !['GET', 'HEAD'].includes(method)) {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const sessionId = sanitizeUploadSessionId(url.searchParams.get('sessionId'));
  const attachmentId = sanitizeUploadAttachmentId(url.searchParams.get('id'));
  if (!sessionId || !attachmentId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Valid sessionId and id query parameters are required.' }));
    return;
  }

  const imagePath = await resolveUploadPathByAttachmentId(workspacePath, sessionId, attachmentId);
  if (!imagePath) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Uploaded image not found.' }));
    return;
  }

  if (!isUploadPathAllowedForSession(workspacePath, sessionId, imagePath)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Upload path is outside the allowed root.' }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': getUploadContentType(imagePath),
    'Cache-Control': 'no-cache',
  });

  if (method === 'HEAD') {
    res.end();
    return;
  }

  const bytes = await fs.readFile(imagePath);
  res.end(bytes);
}

export async function resolveWebMessageAttachments(
  workspacePath: string,
  sessionId: string,
  refs: WSAttachmentRef[] | undefined
): Promise<MessageAttachment[]> {
  return resolveMessageAttachmentRefs(workspacePath, sessionId, refs);
}

export async function handleWebhookInboundRequest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  webhookService: WebhookService,
  webhookId: string,
): Promise<void> {
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  if (!webhookId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Webhook id is required' }));
    return;
  }

  let body: Buffer;
  try {
    body = await readRequestBody(req, WEBHOOK_MAX_BODY_BYTES);
  } catch (error) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Request body too large' }));
    return;
  }

  const signature = req.headers['x-keygate-signature'];
  const signatureValue = Array.isArray(signature) ? signature[0] : signature;
  const result = await webhookService.handleIncoming(webhookId, body.toString('utf8'), signatureValue);

  res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    accepted: result.accepted,
    message: result.message,
    routeId: result.route?.id,
  }));
}

export async function handleGmailPushRequest(
  req: Parameters<typeof handleWebhookInboundRequest>[0],
  res: Parameters<typeof handleWebhookInboundRequest>[1],
  gmailService: GmailAutomationService,
  url: URL,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > WEBHOOK_MAX_BODY_BYTES) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
      return;
    }
    chunks.push(buffer);
  }

  const rawBody = Buffer.concat(chunks).toString('utf8');
  const result = await gmailService.handlePushRequest(
    rawBody,
    typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : undefined,
    url.toString(),
  );
  res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    accepted: result.accepted,
    processed: result.processed,
    message: result.message,
  }));
}

async function handlePluginHttpRequest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  pluginManager: Gateway['plugins'],
  url: URL,
): Promise<void> {
  const pathname = url.pathname.slice('/api/plugins/'.length);
  const [rawPluginId, ...rest] = pathname.split('/');
  const pluginId = rawPluginId?.trim();
  const subPath = rest.join('/').trim();

  if (!pluginId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Plugin id is required.' }));
    return;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let body: unknown = null;
  if (!['GET', 'HEAD'].includes(method)) {
    try {
      const rawBody = await readRequestBody(req, WEBHOOK_MAX_BODY_BYTES);
      const text = rawBody.toString('utf8');
      if (text.trim().length > 0) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = text;
        }
      }
    } catch (error) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Request body too large' }));
      return;
    }
  }

  const headers = Object.fromEntries(
    Object.entries(req.headers).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value.join(', ') : (value ?? ''),
    ])
  );

  try {
    const result = await pluginManager.handleHttpRoute(pluginId, method, subPath, {
      request: req,
      body,
      method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: subPath,
      query: url.searchParams,
      headers,
    });

    if (!result) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Plugin route not found.' }));
      return;
    }

    const responseHeaders = { ...(result.headers ?? {}) };
    if ('json' in result) {
      res.writeHead(result.status, {
        'Content-Type': 'application/json',
        ...responseHeaders,
      });
      res.end(JSON.stringify(result.json));
      return;
    }

    if ('text' in result) {
      res.writeHead(result.status, {
        'Content-Type': 'text/plain; charset=utf-8',
        ...responseHeaders,
      });
      res.end(result.text);
      return;
    }

    res.writeHead(result.status, {
      'Content-Type': result.contentType,
      ...responseHeaders,
    });
    res.end(Buffer.from(result.body));
  } catch (error) {
    const statusCode = error instanceof Error && error.message.includes('Unauthorized') ? 401 : 500;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: sanitizePluginError(error),
    }));
  }
}

async function readRequestBody(
  req: import('node:http').IncomingMessage,
  maxBytes: number
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;

    req.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += bytes.length;
      if (received > maxBytes) {
        reject(new Error(`Image exceeds ${maxBytes} bytes.`));
        req.destroy();
        return;
      }

      chunks.push(bytes);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (error) => {
      reject(error);
    });
  });
}

export async function cleanupExpiredUploadedImages(workspacePath: string, retentionMs: number): Promise<void> {
  await cleanupExpiredUploadedImagesFromStore(workspacePath, retentionMs);
}

export function sanitizeUploadSessionId(value: string | null): string | null {
  return sanitizeUploadSessionIdFromStore(value);
}

export function sanitizeUploadAttachmentId(value: string | null): string | null {
  return sanitizeUploadAttachmentIdFromStore(value);
}

function sanitizePluginError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().length > 0 ? message : 'Plugin invocation failed.';
}

export async function resolveUploadPathByAttachmentId(
  workspacePath: string,
  sessionId: string,
  attachmentId: string
): Promise<string | null> {
  return resolveUploadPathByAttachmentIdFromStore(workspacePath, sessionId, attachmentId);
}

function extractWebChatId(sessionId: string): string {
  const normalized = sessionId.startsWith('web:') ? sessionId.slice(4) : sessionId;
  const segments = normalized.split(':');
  return segments[segments.length - 1] ?? normalized;
}

function isNodeCapability(value: unknown): value is NodeCapability {
  return value === 'notify'
    || value === 'location'
    || value === 'camera'
    || value === 'screen'
    || value === 'shell'
    || value === 'invoke';
}

function mapUploadedAttachmentForTransport(attachment: MessageAttachment): WSAttachmentRef {
  return {
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    url: attachment.url,
  };
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
