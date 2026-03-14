import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import {
  Gateway,
  BaseChannel,
  getChannelActionRegistry,
  RoutingRuleStore,
  RoutingService,
  buildWhatsAppDmChatId,
  cancelActiveWhatsAppLogin,
  clearWhatsAppAuthState,
  createOrGetPairingCode,
  createWhatsAppSocket,
  evaluateWhatsAppGroupPolicy,
  getBrowserScreenshotAllowedRoots,
  getWhatsAppConfig,
  hasWhatsAppLinkedAuth,
  ingestWhatsAppMediaAttachment,
  isLoggedOutDisconnect,
  isPathWithinRoot,
  isUserPaired,
  isWhatsAppDmAllowed,
  loadConfigFromEnv,
  loadEnvironment,
  normalizeWhatsAppGroupKey,
  normalizeWhatsAppMessage,
  normalizeWhatsAppPhoneNumber,
  normalizeWhatsAppUserId,
  readWhatsAppLinkedAccountMeta,
  resolveSessionScreenshotByFilename,
  sanitizeBrowserScreenshotFilename,
  type ChannelActionName,
  type ConfirmationDecision,
  type ConfirmationDetails,
  type KeygateConfig,
} from '@puukis/core';
import { WhatsAppTypingIndicator } from './typing.js';

loadEnvironment();

const SCREENSHOT_FILENAME_GLOBAL_PATTERN = /session-[A-Za-z0-9:_-]+-step-\d+\.png/gi;
const MAX_SEND_CHARS = 3500;
const CONFIRMATION_TIMEOUT_MS = 60_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const INBOUND_ACK_EMOJI = '👀';
const SELF_CHAT_APPEND_WINDOW_MS = 2 * 60_000;

type SendMessageResult = { key?: { id?: string } };

type ConfirmationEntry = {
  token: string;
  chatJid: string;
  userId: string;
  resolve: (decision: ConfirmationDecision) => void;
  timeout: NodeJS.Timeout;
};

const confirmationBroker = new Map<string, ConfirmationEntry>();
const recentBotMessageIdsByChat = new Map<string, Set<string>>();
const pendingPairingNoticesLogged = new Set<string>();

class WhatsAppChannel extends BaseChannel {
  type = 'whatsapp' as const;
  private sock: Awaited<ReturnType<typeof createWhatsAppSocket>>['sock'];
  private chatJid: string;
  private senderId: string;
  private quoted: unknown;
  private artifactsRoot: string;

  constructor(options: {
    sock: Awaited<ReturnType<typeof createWhatsAppSocket>>['sock'];
    chatJid: string;
    senderId: string;
    quoted?: unknown;
    artifactsRoot: string;
  }) {
    super();
    this.sock = options.sock;
    this.chatJid = options.chatJid;
    this.senderId = options.senderId;
    this.quoted = options.quoted;
    this.artifactsRoot = options.artifactsRoot;
  }

  async send(content: string): Promise<void> {
    const chunks = splitTextChunks(content || '(No response)');
    for (const chunk of chunks) {
      const result = await this.sock.sendMessage(
        this.chatJid,
        { text: chunk },
        this.quoted ? ({ quoted: this.quoted } as any) : undefined
      ) as SendMessageResult;
      rememberBotMessage(this.chatJid, result?.key?.id);
    }

    await this.sendScreenshotAttachments(content);
  }

  async sendStream(stream: AsyncIterable<string>): Promise<void> {
    let buffer = '';
    for await (const chunk of stream) {
      buffer += chunk;
    }

    await this.send(buffer || '(No response)');
  }

  async requestConfirmation(prompt: string, details?: ConfirmationDetails): Promise<ConfirmationDecision> {
    const token = randomUUID().slice(0, 6).toUpperCase();
    const detailLines: string[] = [];
    if (details?.summary) {
      detailLines.push(`Summary: ${details.summary}`);
    }
    if (details?.command) {
      detailLines.push(`Command: ${details.command}`);
    }
    if (details?.cwd) {
      detailLines.push(`CWD: ${details.cwd}`);
    }
    if (details?.path) {
      detailLines.push(`Path: ${details.path}`);
    }

    const message = [
      prompt,
      detailLines.length > 0 ? `\n${detailLines.join('\n')}\n` : '',
      `Reply with one of these exactly within 60 seconds:`,
      `ALLOW ${token}`,
      `ALWAYS ${token}`,
      `CANCEL ${token}`,
    ].join('\n');

    await this.send(message);

    return new Promise<ConfirmationDecision>((resolve) => {
      const timeout = setTimeout(() => {
        confirmationBroker.delete(token);
        resolve('cancel');
      }, CONFIRMATION_TIMEOUT_MS);

      confirmationBroker.set(token, {
        token,
        chatJid: this.chatJid,
        userId: this.senderId,
        resolve,
        timeout,
      });
    });
  }

  private extractScreenshotFilenames(content: string): string[] {
    const filenames: string[] = [];
    const seen = new Set<string>();
    SCREENSHOT_FILENAME_GLOBAL_PATTERN.lastIndex = 0;

    let match: RegExpExecArray | null = null;
    while ((match = SCREENSHOT_FILENAME_GLOBAL_PATTERN.exec(content)) !== null) {
      const filename = sanitizeBrowserScreenshotFilename(match[0] ?? '');
      if (!filename) {
        continue;
      }

      const key = filename.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      filenames.push(filename);
    }

    return filenames;
  }

  private async sendScreenshotAttachments(content: string): Promise<void> {
    const filenames = this.extractScreenshotFilenames(content);
    if (filenames.length === 0) {
      return;
    }

    const [artifactsRoot, workspaceRoot] = getBrowserScreenshotAllowedRoots(this.artifactsRoot);
    for (const filename of filenames) {
      const resolvedPath = await resolveSessionScreenshotByFilename(this.artifactsRoot, filename);
      if (!resolvedPath) {
        continue;
      }

      if (!isPathWithinRoot(artifactsRoot, resolvedPath) && !isPathWithinRoot(workspaceRoot, resolvedPath)) {
        continue;
      }

      const bytes = await fs.readFile(resolvedPath);
      const result = await this.sock.sendMessage(
        this.chatJid,
        {
          image: bytes,
          caption: `Browser screenshot: ${filename}`,
        },
        this.quoted ? ({ quoted: this.quoted } as any) : undefined
      ) as SendMessageResult;
      rememberBotMessage(this.chatJid, result?.key?.id);
    }
  }
}

function splitTextChunks(content: string): string[] {
  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_SEND_CHARS) {
      chunks.push(remaining);
      break;
    }

    let breakpoint = remaining.lastIndexOf('\n', MAX_SEND_CHARS);
    if (breakpoint < MAX_SEND_CHARS / 2) {
      breakpoint = remaining.lastIndexOf(' ', MAX_SEND_CHARS);
    }
    if (breakpoint < MAX_SEND_CHARS / 2) {
      breakpoint = MAX_SEND_CHARS;
    }

    chunks.push(remaining.slice(0, breakpoint));
    remaining = remaining.slice(breakpoint).trimStart();
  }

  return chunks.length > 0 ? chunks : ['(No response)'];
}

function rememberBotMessage(chatJid: string, messageId: string | undefined): void {
  if (!messageId) {
    return;
  }

  const bucket = recentBotMessageIdsByChat.get(chatJid) ?? new Set<string>();
  bucket.add(messageId);
  recentBotMessageIdsByChat.set(chatJid, bucket);
  if (bucket.size > 20) {
    const first = bucket.values().next().value;
    if (first) {
      bucket.delete(first);
    }
  }
}

function hasRecentBotMessage(chatJid: string, messageId: string | undefined): boolean {
  if (!messageId) {
    return false;
  }

  return recentBotMessageIdsByChat.get(chatJid)?.has(messageId) === true;
}

function isSelfChatJid(chatJid: string, ownPhone: string | null): boolean {
  if (!ownPhone || chatJid.endsWith('@g.us')) {
    return false;
  }

  return normalizeWhatsAppPhoneNumber(chatJid) === ownPhone;
}

function shouldIgnoreInboundWhatsAppMessage(options: {
  chatJid: string;
  messageId?: string;
  fromMe: boolean;
  ownPhone: string | null;
}): boolean {
  if (!options.chatJid || options.chatJid === 'status@broadcast') {
    return true;
  }

  if (!options.fromMe) {
    return false;
  }

  if (hasRecentBotMessage(options.chatJid, options.messageId)) {
    return true;
  }

  return !isSelfChatJid(options.chatJid, options.ownPhone);
}

function parseWhatsAppMessageTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1_000;
  }

  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isFinite(asNumber)
      ? (asNumber > 1_000_000_000_000 ? asNumber : asNumber * 1_000)
      : null;
  }

  if (value && typeof value === 'object') {
    const candidate = value as { toNumber?: () => number; toString?: () => string };
    if (typeof candidate.toNumber === 'function') {
      const asNumber = candidate.toNumber();
      return Number.isFinite(asNumber)
        ? (asNumber > 1_000_000_000_000 ? asNumber : asNumber * 1_000)
        : null;
    }
    if (typeof candidate.toString === 'function') {
      const asNumber = Number(candidate.toString());
      return Number.isFinite(asNumber)
        ? (asNumber > 1_000_000_000_000 ? asNumber : asNumber * 1_000)
        : null;
    }
  }

  return null;
}

function shouldProcessWhatsAppUpsert(options: {
  upsertType: unknown;
  fromMe: boolean;
  chatJid: string;
  ownPhone: string | null;
  messageTimestampMs: number | null;
  nowMs?: number;
}): boolean {
  if (options.upsertType === 'notify') {
    return true;
  }

  if (options.upsertType !== 'append') {
    return false;
  }

  if (!options.fromMe || !isSelfChatJid(options.chatJid, options.ownPhone)) {
    return false;
  }

  if (options.messageTimestampMs === null) {
    return false;
  }

  return options.messageTimestampMs >= (options.nowMs ?? Date.now()) - SELF_CHAT_APPEND_WINDOW_MS;
}

function maybeResolveConfirmation(chatJid: string, userId: string, text: string): boolean {
  const normalized = text.trim().toUpperCase().replace(/\s+/g, ' ');
  for (const [token, entry] of confirmationBroker.entries()) {
    if (entry.chatJid !== chatJid || entry.userId !== userId) {
      continue;
    }

    if (normalized === `ALLOW ${token}`) {
      clearTimeout(entry.timeout);
      confirmationBroker.delete(token);
      entry.resolve('allow_once');
      return true;
    }
    if (normalized === `ALWAYS ${token}`) {
      clearTimeout(entry.timeout);
      confirmationBroker.delete(token);
      entry.resolve('allow_always');
      return true;
    }
    if (normalized === `CANCEL ${token}`) {
      clearTimeout(entry.timeout);
      confirmationBroker.delete(token);
      entry.resolve('cancel');
      return true;
    }
  }

  return false;
}

function extractMessageText(message: Record<string, unknown> | undefined): string {
  if (!message) {
    return '';
  }

  if (typeof message['conversation'] === 'string') {
    return message['conversation'];
  }

  const extended = message['extendedTextMessage'] as Record<string, unknown> | undefined;
  if (extended && typeof extended['text'] === 'string') {
    return extended['text'];
  }

  const image = message['imageMessage'] as Record<string, unknown> | undefined;
  if (image && typeof image['caption'] === 'string') {
    return image['caption'];
  }

  const video = message['videoMessage'] as Record<string, unknown> | undefined;
  if (video && typeof video['caption'] === 'string') {
    return video['caption'];
  }

  const document = message['documentWithCaptionMessage'] as Record<string, unknown> | undefined;
  const documentMessage = document?.['message'] as Record<string, unknown> | undefined;
  const documentWithCaption = documentMessage?.['documentMessage'] as Record<string, unknown> | undefined;
  if (documentWithCaption && typeof documentWithCaption['caption'] === 'string') {
    return documentWithCaption['caption'];
  }

  return '';
}

function extractContextInfo(message: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!message) {
    return undefined;
  }

  const extended = message['extendedTextMessage'] as Record<string, unknown> | undefined;
  if (extended?.['contextInfo'] && typeof extended['contextInfo'] === 'object') {
    return extended['contextInfo'] as Record<string, unknown>;
  }

  const candidates = ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage'];
  for (const key of candidates) {
    const candidate = message[key] as Record<string, unknown> | undefined;
    if (candidate?.['contextInfo'] && typeof candidate['contextInfo'] === 'object') {
      return candidate['contextInfo'] as Record<string, unknown>;
    }
  }

  return undefined;
}

async function runWhatsAppRuntime(config: KeygateConfig): Promise<void> {
  if (!await hasWhatsAppLinkedAuth()) {
    throw new Error('WhatsApp is not linked. Run `keygate channels whatsapp login` first.');
  }

  await cancelActiveWhatsAppLogin();

  const gateway = Gateway.getInstance(config);
  const router = new RoutingService(new RoutingRuleStore(), config.security.workspacePath);
  const runtimeConfig = getWhatsAppConfig(config);

  let reconnectDelayMs = 1_000;

  while (true) {
    console.log('[whatsapp] opening linked-device session');
    const session = await createWhatsAppSocket({
      onConnectionUpdate: async (update, sock) => {
        if (update.connection === 'open') {
          const phone = normalizeWhatsAppPhoneNumber(sock.user?.id);
          console.log(`[whatsapp] connected${phone ? ` as ${phone}` : ''}`);
        }
      },
    });
    registerWhatsAppActionAdapter(session.sock, config);

    try {
      const outcome = await new Promise<'reconnect' | 'fatal' | 'shutdown'>((resolve) => {
        session.sock.ev.on('messages.upsert', (event) => {
          void handleMessages({
            config,
            runtimeConfig,
            gateway,
            router,
            sock: session.sock,
            upsertType: typeof (event as { type?: unknown }).type === 'string'
              ? (event as { type?: string }).type
              : undefined,
            messages: (event.messages ?? []) as unknown as Array<Record<string, unknown>>,
          });
        });

        session.sock.ev.on('connection.update', async (update) => {
          if (update.connection === 'open') {
            reconnectDelayMs = 1_000;
          }

          if (update.connection !== 'close') {
            return;
          }

          if (isLoggedOutDisconnect(update)) {
            console.error('[whatsapp] linked session was logged out; clearing local auth and exiting');
            await clearWhatsAppAuthState();
            resolve('fatal');
            return;
          }

          console.warn('[whatsapp] disconnected; scheduling reconnect');
          resolve('reconnect');
        });
      });

      await session.close();

      if (outcome === 'fatal' || outcome === 'shutdown') {
        return;
      }

      await sleep(reconnectDelayMs);
      reconnectDelayMs = Math.min(MAX_RECONNECT_DELAY_MS, reconnectDelayMs * 2);
    } catch (error) {
      await session.close();
      console.error('[whatsapp] runtime error:', error);
      await sleep(reconnectDelayMs);
      reconnectDelayMs = Math.min(MAX_RECONNECT_DELAY_MS, reconnectDelayMs * 2);
    }
  }
}

async function handleMessages(options: {
  config: KeygateConfig;
  runtimeConfig: ReturnType<typeof getWhatsAppConfig>;
  gateway: Gateway;
  router: RoutingService;
  sock: Awaited<ReturnType<typeof createWhatsAppSocket>>['sock'];
  upsertType: string | undefined;
  messages: Array<Record<string, unknown>>;
}): Promise<void> {
  for (const rawMessage of options.messages) {
    try {
      await handleSingleMessage(options, rawMessage);
    } catch (error) {
      console.error('[whatsapp] failed to process inbound message:', error);
    }
  }
}

function registerWhatsAppActionAdapter(
  sock: Awaited<ReturnType<typeof createWhatsAppSocket>>['sock'],
  config: KeygateConfig,
): void {
  const gate = config.actions?.whatsapp ?? {
    send: true,
    react: true,
    poll: true,
    reply: true,
  };
  const actions: ChannelActionName[] = [];
  if (gate.send !== false) actions.push('send');
  if (gate.react !== false) actions.push('react');
  if (gate.poll !== false) actions.push('poll');
  if (gate.reply !== false) actions.push('reply');

  getChannelActionRegistry().register({
    channel: 'whatsapp',
    actions,
    handle: async (ctx) => {
      const chatJid = firstWhatsAppString(ctx.params['chatJid'], ctx.params['channelId']);
      const messageId = firstWhatsAppString(ctx.params['messageId']);
      const participant = firstWhatsAppString(ctx.params['participant']);
      const content = firstWhatsAppString(ctx.params['content']) ?? '';

      if (!chatJid) {
        return { ok: false, channel: 'whatsapp', error: 'WhatsApp actions require chatJid.' };
      }

      if (ctx.action === 'send') {
        const sent = await sock.sendMessage(chatJid, { text: content || '(No response)' }) as SendMessageResult;
        return {
          ok: true,
          channel: 'whatsapp',
          externalMessageId: sent?.key?.id,
          payload: { content },
        };
      }

      if (ctx.action === 'poll') {
        const question = firstWhatsAppString(ctx.params['question']);
        const options = Array.isArray(ctx.params['options'])
          ? ctx.params['options'].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          : [];
        if (!question || options.length < 2) {
          return { ok: false, channel: 'whatsapp', error: 'WhatsApp poll requires a question and at least two options.' };
        }
        const sent = await sock.sendMessage(chatJid, {
          poll: {
            name: question,
            values: options,
            selectableCount: ctx.params['multiple'] === true ? options.length : 1,
          },
        } as any) as SendMessageResult;
        return {
          ok: true,
          channel: 'whatsapp',
          externalMessageId: sent?.key?.id,
          pollId: sent?.key?.id,
          payload: { question, options, multiple: ctx.params['multiple'] === true },
        };
      }

      if (!messageId) {
        return { ok: false, channel: 'whatsapp', error: `${ctx.action} requires messageId.` };
      }

      const messageKey = {
        remoteJid: chatJid,
        id: messageId,
        fromMe: false,
        ...(participant ? { participant } : {}),
      };

      if (ctx.action === 'react') {
        const emoji = firstWhatsAppString(ctx.params['emoji']);
        if (!emoji) {
          return { ok: false, channel: 'whatsapp', error: 'WhatsApp react requires emoji.' };
        }
        await sock.sendMessage(chatJid, {
          react: {
            text: emoji,
            key: messageKey,
          },
        } as any);
        return {
          ok: true,
          channel: 'whatsapp',
          externalMessageId: messageId,
          payload: { emoji },
        };
      }

      if (ctx.action === 'reply') {
        const sent = await sock.sendMessage(
          chatJid,
          { text: content || '(No response)' },
          { quoted: { key: messageKey } as any },
        ) as SendMessageResult;
        return {
          ok: true,
          channel: 'whatsapp',
          externalMessageId: sent?.key?.id,
          payload: { content, replyTo: messageId },
        };
      }

      return { ok: false, channel: 'whatsapp', error: `${ctx.action} is not supported for WhatsApp.` };
    },
  });
}

function firstWhatsAppString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

async function handleSingleMessage(
  options: {
    config: KeygateConfig;
    runtimeConfig: ReturnType<typeof getWhatsAppConfig>;
    gateway: Gateway;
    router: RoutingService;
    sock: Awaited<ReturnType<typeof createWhatsAppSocket>>['sock'];
    upsertType: string | undefined;
  },
  rawMessage: Record<string, unknown>
): Promise<void> {
  const key = (rawMessage['key'] && typeof rawMessage['key'] === 'object')
    ? rawMessage['key'] as Record<string, unknown>
    : undefined;
  const chatJid = typeof key?.['remoteJid'] === 'string' ? key['remoteJid'] : '';
  const messageId = typeof key?.['id'] === 'string' ? key['id'] : undefined;
  const fromMe = key?.['fromMe'] === true;
  const linkedMeta = await readWhatsAppLinkedAccountMeta();
  const ownPhone = normalizeWhatsAppPhoneNumber(options.sock.user?.id)
    ?? normalizeWhatsAppPhoneNumber(linkedMeta?.phoneNumber ?? linkedMeta?.jid);
  const messageTimestampMs = parseWhatsAppMessageTimestampMs(rawMessage['messageTimestamp']);
  if (!shouldProcessWhatsAppUpsert({
    upsertType: options.upsertType,
    fromMe,
    chatJid,
    ownPhone,
    messageTimestampMs,
  })) {
    return;
  }
  if (shouldIgnoreInboundWhatsAppMessage({
    chatJid,
    messageId,
    fromMe,
    ownPhone,
  })) {
    return;
  }

  const message = rawMessage['message'] && typeof rawMessage['message'] === 'object'
    ? rawMessage['message'] as Record<string, unknown>
    : undefined;
  const text = extractMessageText(message).trim();
  const isGroup = chatJid.endsWith('@g.us');
  const isSelfChat = isSelfChatJid(chatJid, ownPhone);
  const senderJid = typeof key?.['participant'] === 'string'
    ? key['participant']
    : chatJid;
  const userId = normalizeWhatsAppUserId(senderJid) ?? senderJid;

  if (text && maybeResolveConfirmation(chatJid, userId, text)) {
    return;
  }

  const contextInfo = extractContextInfo(message);
  const mentionedJids = Array.isArray(contextInfo?.['mentionedJid'])
    ? contextInfo['mentionedJid'].filter((entry): entry is string => typeof entry === 'string')
    : [];
  const mentionedSelf = ownPhone
    ? mentionedJids.some((jid) => normalizeWhatsAppPhoneNumber(jid) === ownPhone)
    : false;
  const stanzaId = typeof contextInfo?.['stanzaId'] === 'string' ? contextInfo['stanzaId'] : undefined;
  const repliedToRecentBotMessage = Boolean(stanzaId && recentBotMessageIdsByChat.get(chatJid)?.has(stanzaId));

  if (isGroup) {
    const groupPolicy = evaluateWhatsAppGroupPolicy({
      config: options.runtimeConfig,
      groupIdOrKey: chatJid,
      mentionedSelf,
      repliedToRecentBotMessage,
    });
    if (!groupPolicy.allowed) {
      console.log(`[whatsapp] dropped group message (${groupPolicy.reason}) group=${groupPolicy.groupKey}`);
      return;
    }
  }

  if (!isGroup) {
    const paired = isSelfChat ? true : await isUserPaired('whatsapp', userId);
    const allowed = isSelfChat
      ? true
      : isWhatsAppDmAllowed({
        config: options.runtimeConfig,
        userId,
        paired,
      });

    if (!allowed && options.runtimeConfig.dmPolicy === 'pairing') {
      const request = await createOrGetPairingCode('whatsapp', userId);
      const pendingKey = `${chatJid}:${userId}:${request.code}`;
      if (!pendingPairingNoticesLogged.has(pendingKey)) {
        pendingPairingNoticesLogged.add(pendingKey);
        console.log(
          `[whatsapp] blocked unpaired DM from ${userId}; pending code ${request.code}. `
          + `Review with: keygate pairing pending whatsapp | Approve with: keygate pairing approve whatsapp ${request.code}`
        );
      }
      return;
    }

    if (!allowed) {
      console.log(`[whatsapp] blocked DM from ${userId}; sender is not allowlisted.`);
      return;
    }
  }

  const groupKey = isGroup ? normalizeWhatsAppGroupKey(chatJid) : null;
  const route = await options.router.resolve({
    channel: 'whatsapp',
    accountId: undefined,
    chatId: groupKey ?? buildWhatsAppDmChatId(userId),
    userId,
  });
  const sessionId = route.sessionId;
  await options.gateway.prepareSessionWorkspace(sessionId, route.workspacePath);

  const media = await ingestWhatsAppMediaAttachment(route.workspacePath, sessionId, options.sock, rawMessage as { key?: unknown; message?: unknown });
  if (media.rejectionReason) {
    await options.sock.sendMessage(chatJid, {
      text: media.rejectionReason,
    });
  }

  if (!text && !media.attachment) {
    return;
  }

  if (key) {
    try {
      await options.sock.sendMessage(chatJid, {
        react: {
          text: INBOUND_ACK_EMOJI,
          key: key as any,
        },
      } as any);
    } catch {
      // Ignore reaction failures due to unsupported clients or permissions.
    }
  }

  if (options.runtimeConfig.sendReadReceipts && key) {
    try {
      await options.sock.readMessages([key as any]);
    } catch {
      // Ignore read receipt failures.
    }
  }

  const channel = new WhatsAppChannel({
    sock: options.sock,
    chatJid,
    senderId: userId,
    quoted: rawMessage,
    artifactsRoot: options.config.browser.artifactsPath,
  });

  const normalized = normalizeWhatsAppMessage(
    messageId ?? randomUUID(),
    groupKey ?? buildWhatsAppDmChatId(userId),
    userId,
    text,
    channel,
    media.attachment ? [media.attachment] : undefined,
    sessionId,
  );

  const typing = new WhatsAppTypingIndicator(options.sock, chatJid);
  typing.start();
  try {
    await options.gateway.processMessage(normalized);
  } finally {
    typing.stop();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfigFromEnv();
  runWhatsAppRuntime(config).catch((error) => {
    console.error('[whatsapp] fatal error:', error);
    process.exitCode = 1;
  });
}

export {
  runWhatsAppRuntime,
  WhatsAppChannel,
  WhatsAppTypingIndicator,
  splitTextChunks,
  isSelfChatJid,
  shouldIgnoreInboundWhatsAppMessage,
  shouldProcessWhatsAppUpsert,
};
