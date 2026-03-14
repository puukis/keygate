import {
  Gateway,
  getChannelActionRegistry,
  normalizeTelegramMessage,
  loadConfigFromEnv,
  loadEnvironment,
  RoutingRuleStore,
  RoutingService,
  type ChannelActionName,
  type KeygateConfig,
} from '@puukis/core';
import { Bot, type Context } from 'grammy';
import { run } from '@grammyjs/runner';
import { TelegramChannel, pendingConfirmations } from './channel.js';
import { TypingIndicator } from './typing.js';
import { UpdateDeduplicator } from './dedup.js';
import { checkDmAccess } from './dm-access.js';
import { isGroupAllowed } from './group-access.js';
import { ingestTelegramMediaAttachments } from './media.js';
import { buildSessionKey } from './session-key.js';
import { registerBotCommands, parseTelegramCommand } from './commands.js';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

loadEnvironment();

// ── Log file setup (stdout/stderr may be /dev/null in daemon mode) ─────────
process.on('unhandledRejection', (reason) => {
  console.error('[Telegram] unhandledRejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Telegram] uncaughtException:', err.stack);
});
const keygateDir = path.join(os.homedir(), '.keygate');
try { mkdirSync(keygateDir, { recursive: true }); } catch { /* ignore */ }
const logFile = createWriteStream(path.join(keygateDir, 'telegram.log'), { flags: 'a' });
const origLog = console.log.bind(console);
const origWarn = console.warn.bind(console);
const origError = console.error.bind(console);
const writeLog = (level: string, args: unknown[]) => {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(String).join(' ')}\n`;
  logFile.write(line);
};
console.log = (...args: unknown[]) => { writeLog('INFO', args); origLog(...args); };
console.warn = (...args: unknown[]) => { writeLog('WARN', args); origWarn(...args); };
console.error = (...args: unknown[]) => { writeLog('ERROR', args); origError(...args); };

/**
 * Start the Telegram bot.
 * Returns a stop function that gracefully shuts the bot down.
 */
export async function startTelegramBot(config: KeygateConfig): Promise<{ stop(): Promise<void> }> {
  const token = config.telegram?.token ?? process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) {
    throw new Error('Telegram bot token not configured. Set TELEGRAM_BOT_TOKEN or provide in config.');
  }

  const telegramConfig = config.telegram!;
  const gateway = Gateway.getInstance(config);
  const router = new RoutingService(new RoutingRuleStore(), config.security.workspacePath);
  const dedup = new UpdateDeduplicator();

  const bot = new Bot<Context>(token);
  registerTelegramActionAdapter(bot, config);

  // Clear any stale webhook so polling works cleanly and allowed_updates is reset
  await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});

  // Resolve bot username for mention-gating
  let botUsername = '';
  try {
    const me = await bot.api.getMe();
    botUsername = me.username ?? '';
    console.log(`🤖 Telegram bot ready! @${botUsername}`);
  } catch (error) {
    console.error('Failed to get Telegram bot info:', error);
    throw error;
  }

  await registerBotCommands(bot.api);

  // ── Inline keyboard callback handler (for confirmation dialogs) ──────────
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const match = data.match(/^confirm:([^:]+):(allow_once|allow_always|cancel)$/);
    if (match) {
      const uuid = match[1]!;
      const decision = match[2] as 'allow_once' | 'allow_always' | 'cancel';
      const resolver = pendingConfirmations.get(uuid);
      const callbackText = decision === 'cancel'
        ? 'Cancelled.'
        : decision === 'allow_always'
          ? 'Approved. Matching requests will stay allowed.'
          : 'Approved. Continuing...';
      if (resolver) {
        pendingConfirmations.delete(uuid);
        resolver(decision);
      } else {
        console.warn(`[Telegram] callback_query: no pending confirmation for uuid=${uuid} (pendingCount=${pendingConfirmations.size})`);
      }
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch((e) => {
        console.warn('[Telegram] failed to clear confirmation keyboard:', e);
      });
      await ctx.answerCallbackQuery({ text: resolver ? callbackText : 'This approval is no longer active.' }).catch((e) => {
        console.error('[Telegram] answerCallbackQuery failed:', e);
      });
    } else {
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });

  // ── Main message handler ─────────────────────────────────────────────────
  bot.on('message', async (ctx) => {
    const msg = ctx.message;
    if (!msg) return;

    // Deduplicate
    if (dedup.isDuplicate(ctx.update.update_id)) return;
    dedup.markSeen(ctx.update.update_id);

    // Only handle text or media messages
    const hasText = typeof msg.text === 'string' && msg.text.length > 0;
    const hasMedia = !!(msg.photo || msg.document || msg.voice || msg.video || msg.sticker);
    if (!hasText && !hasMedia) return;

    const chatType = msg.chat.type; // 'private' | 'group' | 'supergroup' | 'channel'
    const isPrivate = chatType === 'private';
    const isGroup = chatType === 'group' || chatType === 'supergroup';
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (!userId) return;

    // Forum topic thread id
    const isForumTopic = 'is_forum' in msg.chat && msg.chat.is_forum === true;
    const topicId = isForumTopic && msg.message_thread_id ? msg.message_thread_id : undefined;

    const messageText = msg.text ?? msg.caption ?? '';

    // ── Group access check ──
    if (isGroup) {
      const access = isGroupAllowed(telegramConfig, chatId, messageText, botUsername);
      if (!access.allowed) return;
    }

    // ── DM access check ──
    if (isPrivate) {
      const access = await checkDmAccess(telegramConfig, userId);
      if (!access.allowed) {
        if (access.pairingCode) {
          await ctx.reply(
            `🔐 DM pairing required. Your code: <code>${access.pairingCode}</code>\n` +
            `Ask the owner to run: <code>keygate pairing approve telegram ${access.pairingCode}</code>`,
            { parse_mode: 'HTML' },
          ).catch(() => {});
        }
        return;
      }
    }

    // Acknowledge with eyes reaction
    try {
      await ctx.react([{ type: 'emoji', emoji: '👀' }]);
    } catch {
      // Reactions require appropriate permissions; ignore failures
    }

    const sessionKey = buildSessionKey(chatId, topicId);

    const typing = new TypingIndicator(bot.api, chatId, topicId);
    typing.start();

    try {
      const route = await router.resolve({
        channel: 'telegram',
        chatId: sessionKey,
        userId: String(userId),
      });
      const sessionId = route.sessionId;
      await gateway.prepareSessionWorkspace(sessionId, route.workspacePath);

      // Ingest media attachments
      const attachments = await ingestTelegramMediaAttachments(
        route.workspacePath,
        sessionId,
        ctx,
        token,
      );

      // Determine effective content
      let content = messageText;

      // If mention-gated group, strip the mention already done in isGroupAllowed result
      if (isGroup && telegramConfig.groupMode === 'mention') {
        const access = isGroupAllowed(telegramConfig, chatId, messageText, botUsername);
        content = access.contentAfterMention;
      }

      // Check if it's a slash command
      const slashCommand = content.trim().startsWith('/') ? parseTelegramCommand(content.trim()) : null;
      const effectiveContent = slashCommand ?? content;

      if (!effectiveContent && attachments.length === 0) {
        return;
      }

      const channel = new TelegramChannel(bot.api, chatId, msg.message_id, topicId);
      const normalized = normalizeTelegramMessage(
        String(msg.message_id),
        sessionKey,
        String(userId),
        effectiveContent,
        channel,
        attachments.length > 0 ? attachments : undefined,
        sessionId,
      );

      await gateway.processMessage(normalized);
    } catch (error) {
      console.error('[Telegram] Error processing message:', error instanceof Error ? error.stack : error);
      await ctx.reply('❌ An error occurred while processing your request.').catch(() => {});
    } finally {
      typing.stop();
    }
  });

  // ── Start bot ─────────────────────────────────────────────────────────────
  const webhookUrl = telegramConfig.webhookUrl;

  // The update types this bot needs to receive
  const allowedUpdates = ['message', 'callback_query'] as const;

  if (webhookUrl) {
    // Webhook mode
    const port = telegramConfig.webhookPort ?? 8787;
    const path = telegramConfig.webhookPath ?? '/telegram/webhook';

    await bot.api.setWebhook(webhookUrl + path, { allowed_updates: allowedUpdates });

    const { createServer } = await import('node:http');
    const { webhookCallback } = await import('grammy');
    const handleUpdate = webhookCallback(bot, 'http');
    const server = createServer(async (req, res) => {
      if (req.url === path && req.method === 'POST') {
        await handleUpdate(req, res);
      } else {
        res.writeHead(404).end();
      }
    });

    await new Promise<void>((resolve) => server.listen(port, resolve));
    console.log(`Telegram webhook listening on port ${port} at ${path}`);

    return {
      stop: async () => {
        await bot.api.deleteWebhook().catch(() => {});
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve()))
        );
      },
    };
  } else {
    // Long polling mode (default)
    // Explicitly specify allowed_updates so Telegram sends callback_query events
    // even if a previous webhook session had a different configuration.
    const runner = run(bot, {
      runner: { fetch: { allowed_updates: allowedUpdates } },
    });
    console.log('Telegram bot started (long polling).');

    return {
      stop: async () => {
        runner.isRunning() && (await runner.stop());
      },
    };
  }
}

function registerTelegramActionAdapter(bot: Bot<Context>, config: KeygateConfig): void {
  const gate = config.actions?.telegram ?? {
    send: true,
    react: true,
    edit: true,
    delete: true,
    poll: true,
    topicCreate: true,
    threadReply: true,
  };
  const actions: ChannelActionName[] = [];
  if (gate.send !== false) actions.push('send');
  if (gate.react !== false) actions.push('react');
  if (gate.edit !== false) actions.push('edit');
  if (gate.delete !== false) actions.push('delete');
  if (gate.poll !== false) actions.push('poll');
  if (gate.topicCreate !== false) actions.push('topic-create');
  if (gate.threadReply !== false) actions.push('thread-reply');

  getChannelActionRegistry().register({
    channel: 'telegram',
    actions,
    handle: async (ctx) => {
      const chatId = parseTelegramChatId(ctx.params['chatId']);
      const messageId = typeof ctx.params['messageId'] === 'number'
        ? Math.floor(ctx.params['messageId'])
        : Number.parseInt(String(ctx.params['messageId'] ?? ''), 10);
      const threadId = typeof ctx.params['threadId'] === 'number'
        ? Math.floor(ctx.params['threadId'])
        : Number.parseInt(String(ctx.params['threadId'] ?? ''), 10);
      const content = typeof ctx.params['content'] === 'string' ? ctx.params['content'].trim() : '';

      if (!chatId) {
        return { ok: false, channel: 'telegram', error: 'Telegram actions require chatId.' };
      }

      if (ctx.action === 'send') {
        const sent = await bot.api.sendMessage(chatId, content || '(No response)');
        return {
          ok: true,
          channel: 'telegram',
          externalMessageId: String(sent.message_id),
          payload: { content },
        };
      }

      if (ctx.action === 'thread-reply') {
        if (!Number.isFinite(threadId)) {
          return { ok: false, channel: 'telegram', error: 'Telegram thread-reply requires threadId.' };
        }
        const sent = await bot.api.sendMessage(chatId, content || '(No response)', {
          message_thread_id: threadId,
        });
        return {
          ok: true,
          channel: 'telegram',
          externalMessageId: String(sent.message_id),
          threadId: String(threadId),
          payload: { content, threadId },
        };
      }

      if (ctx.action === 'topic-create') {
        const name = typeof ctx.params['name'] === 'string' && ctx.params['name'].trim().length > 0
          ? ctx.params['name'].trim()
          : `Topic ${new Date().toLocaleString()}`;
        const topic = await (bot.api as any).createForumTopic(chatId, name);
        return {
          ok: true,
          channel: 'telegram',
          threadId: String(topic.message_thread_id),
          payload: { name, threadId: topic.message_thread_id },
        };
      }

      if (ctx.action === 'poll') {
        const question = typeof ctx.params['question'] === 'string' ? ctx.params['question'].trim() : '';
        const options = Array.isArray(ctx.params['options'])
          ? ctx.params['options'].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          : [];
        if (!question || options.length < 2) {
          return { ok: false, channel: 'telegram', error: 'Telegram poll requires a question and at least two options.' };
        }
        const sent = await bot.api.sendPoll(chatId, question, options, {
          allows_multiple_answers: ctx.params['multiple'] === true,
        });
        return {
          ok: true,
          channel: 'telegram',
          externalMessageId: String(sent.message_id),
          pollId: sent.poll.id,
          payload: { question, options, multiple: ctx.params['multiple'] === true },
        };
      }

      if (!Number.isFinite(messageId)) {
        return { ok: false, channel: 'telegram', error: `${ctx.action} requires messageId.` };
      }

      if (ctx.action === 'edit') {
        await bot.api.editMessageText(chatId, messageId, content || '(No response)');
        return {
          ok: true,
          channel: 'telegram',
          externalMessageId: String(messageId),
          payload: { content },
        };
      }

      if (ctx.action === 'delete') {
        await bot.api.deleteMessage(chatId, messageId);
        return {
          ok: true,
          channel: 'telegram',
          externalMessageId: String(messageId),
          payload: { deleted: true },
        };
      }

      if (ctx.action === 'react') {
        const emoji = typeof ctx.params['emoji'] === 'string' ? ctx.params['emoji'].trim() : '';
        if (!emoji) {
          return { ok: false, channel: 'telegram', error: 'Telegram react requires emoji.' };
        }
        await (bot.api as any).setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji }]);
        return {
          ok: true,
          channel: 'telegram',
          externalMessageId: String(messageId),
          payload: { emoji },
        };
      }

      return { ok: false, channel: 'telegram', error: `${ctx.action} is not supported for Telegram.` };
    },
  });
}

function parseTelegramChatId(value: unknown): number | string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? Math.floor(numeric) : trimmed;
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfigFromEnv();
  startTelegramBot(config).catch(console.error);
}
