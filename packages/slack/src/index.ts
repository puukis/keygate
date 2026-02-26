import { randomUUID } from 'node:crypto';
import { App, type SayFn } from '@slack/bolt';
import {
  Gateway,
  normalizeSlackMessage,
  BaseChannel,
  loadConfigFromEnv,
  loadEnvironment,
  IMAGE_UPLOAD_ALLOWED_MIME_TYPES,
  IMAGE_UPLOAD_MAX_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
  normalizeUploadMimeType,
  persistUploadedImage,
  type ConfirmationDetails,
  type ConfirmationDecision,
  type KeygateConfig,
  type MessageAttachment,
  createOrGetPairingCode,
  isDmAllowedByPolicy,
  isUserPaired,
  RoutingRuleStore,
  RoutingService,
} from '@puukis/core';

loadEnvironment();

const SLACK_MAX_MESSAGE_LENGTH = 3000;
const CONFIRMATION_TIMEOUT_MS = 60_000;
const CONFIRMATION_ACTION_ID = 'keygate_confirm';

type ConfirmationBrokerEntry = {
  expectedUserId: string;
  channelId: string;
  threadTs: string;
  resolve: (decision: ConfirmationDecision) => void;
  timeout: NodeJS.Timeout;
};

interface SlackFileLike {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

const confirmationBroker = new Map<string, ConfirmationBrokerEntry>();

/**
 * Slack Channel adapter implementing the Channel interface
 */
class SlackChannel extends BaseChannel {
  type = 'slack' as const;
  private say: SayFn;
  private threadTs: string;
  private channelId: string;
  private requestUserId: string;
  private useThreadReplies: boolean;

  constructor(say: SayFn, channelId: string, threadTs: string, requestUserId: string, useThreadReplies = true) {
    super();
    this.say = say;
    this.channelId = channelId;
    this.threadTs = threadTs;
    this.requestUserId = requestUserId;
    this.useThreadReplies = useThreadReplies;
  }

  async send(content: string): Promise<void> {
    const chunks = this.splitMessage(content);
    for (const chunk of chunks) {
      await this.say(this.composeReply(chunk));
    }
  }

  async sendStream(stream: AsyncIterable<string>): Promise<void> {
    let buffer = '';

    for await (const chunk of stream) {
      buffer += chunk;
    }

    const text = buffer || '(No response)';
    const chunks = this.splitMessage(text);
    for (const chunk of chunks) {
      await this.say(this.composeReply(chunk));
    }
  }

  private composeReply(text: string): { text: string; thread_ts?: string } {
    if (this.useThreadReplies) {
      return { text, thread_ts: this.threadTs };
    }

    return { text };
  }

  async requestConfirmation(prompt: string, details?: ConfirmationDetails): Promise<ConfirmationDecision> {
    const detailLines: string[] = [];
    if (details?.summary) {
      detailLines.push(`*Summary:* ${details.summary}`);
    }
    if (details?.command) {
      detailLines.push(`*Command:* \`${details.command}\``);
    }
    if (details?.cwd) {
      detailLines.push(`*CWD:* ${details.cwd}`);
    }
    if (details?.path) {
      detailLines.push(`*Path:* ${details.path}`);
    }

    const requestId = randomUUID();
    const blocks = [
      {
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: `${prompt}${detailLines.length > 0 ? `\n\n${detailLines.join('\n')}` : ''}`,
        },
      },
      {
        type: 'actions' as const,
        block_id: requestId,
        elements: [
          {
            type: 'button' as const,
            text: { type: 'plain_text' as const, text: '✅ Allow Once' },
            action_id: CONFIRMATION_ACTION_ID,
            style: 'primary' as const,
            value: serializeConfirmationActionValue(requestId, 'allow_once'),
          },
          {
            type: 'button' as const,
            text: { type: 'plain_text' as const, text: '♾️ Allow Always' },
            action_id: CONFIRMATION_ACTION_ID,
            value: serializeConfirmationActionValue(requestId, 'allow_always'),
          },
          {
            type: 'button' as const,
            text: { type: 'plain_text' as const, text: '❌ Cancel' },
            action_id: CONFIRMATION_ACTION_ID,
            style: 'danger' as const,
            value: serializeConfirmationActionValue(requestId, 'cancel'),
          },
        ],
      },
    ];

    return new Promise<ConfirmationDecision>((resolve) => {
      const timeout = setTimeout(() => {
        const pending = confirmationBroker.get(requestId);
        if (!pending) {
          return;
        }

        confirmationBroker.delete(requestId);
        pending.resolve('cancel');
      }, CONFIRMATION_TIMEOUT_MS);

      confirmationBroker.set(requestId, {
        expectedUserId: this.requestUserId,
        channelId: this.channelId,
        threadTs: this.threadTs,
        timeout,
        resolve,
      });

      void this.say({
        text: prompt,
        blocks,
        ...(this.useThreadReplies ? { thread_ts: this.threadTs } : {}),
      }).catch(() => {
        resolveConfirmationDecision(requestId, 'cancel');
      });
    });
  }

  private splitMessage(content: string, maxLength = SLACK_MAX_MESSAGE_LENGTH): string[] {
    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      let breakPoint = remaining.lastIndexOf('\n', maxLength);
      if (breakPoint === -1 || breakPoint < maxLength / 2) {
        breakPoint = remaining.lastIndexOf(' ', maxLength);
      }
      if (breakPoint === -1 || breakPoint < maxLength / 2) {
        breakPoint = maxLength;
      }

      chunks.push(remaining.slice(0, breakPoint));
      remaining = remaining.slice(breakPoint).trimStart();
    }

    return chunks;
  }
}

/**
 * Start the Slack bot using Socket Mode (no public URL required)
 */
export async function startSlackBot(config: KeygateConfig): Promise<App> {
  const botToken = config.slack?.botToken ?? process.env['SLACK_BOT_TOKEN'];
  const appToken = config.slack?.appToken ?? process.env['SLACK_APP_TOKEN'];
  const signingSecret = config.slack?.signingSecret ?? process.env['SLACK_SIGNING_SECRET'] ?? '';

  if (!botToken) {
    throw new Error('Slack bot token not configured. Set SLACK_BOT_TOKEN or provide in config.');
  }
  if (!appToken) {
    throw new Error('Slack app token not configured. Set SLACK_APP_TOKEN or provide in config.');
  }

  const app = new App({
    token: botToken,
    appToken,
    signingSecret,
    socketMode: true,
  });

  const gateway = Gateway.getInstance(config);
  const router = new RoutingService(new RoutingRuleStore(), config.security.workspacePath);
  registerConfirmationActionHandler(app);

  // Respond to direct mentions
  app.event('app_mention', async ({ event, say, client }) => {
    const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    const threadTs = event.thread_ts ?? event.ts;
    const channelId = event.channel;
    const userId = event.user ?? '';
    const route = await router.resolve({
      channel: 'slack',
      accountId: ('team' in event && typeof event.team === 'string') ? event.team : undefined,
      chatId: channelId,
      userId,
    });
    const sessionId = route.sessionId;
    gateway.setSessionWorkspace(sessionId, route.workspacePath);

    try {
      const attachments = await ingestSlackImageAttachments(
        route.workspacePath,
        sessionId,
        (event as unknown as { files?: unknown }).files,
        botToken,
      );
      if (!text && attachments.length === 0) {
        return;
      }

      await client.reactions.add({ channel: channelId, timestamp: event.ts, name: 'eyes' }).catch(() => {});
      const channel = new SlackChannel(say, channelId, threadTs, userId);
      const normalized = normalizeSlackMessage(
        event.ts,
        channelId,
        userId,
        text,
        channel,
        attachments.length > 0 ? attachments : undefined,
        sessionId,
      );

      await gateway.processMessage(normalized);
    } catch (error) {
      console.error('Error processing Slack mention:', error);
      await say({ text: '❌ An error occurred while processing your request.', thread_ts: threadTs });
    }
  });

  // Respond to direct messages
  app.event('message', async ({ event, say, client }) => {
    // Ignore bot messages, subtypes (edits, joins, etc.)
    if ('bot_id' in event && event.bot_id) return;
    if (event.subtype) return;

    // Only handle DMs (channel type 'im')
    if (!('channel_type' in event) || event.channel_type !== 'im') return;

    const text = ('text' in event ? (event.text ?? '') : '').trim();
    const threadTs = ('thread_ts' in event && typeof event.thread_ts === 'string' ? event.thread_ts : undefined) ?? event.ts;
    const channelId = event.channel;
    const userId = 'user' in event ? (event.user ?? '') : '';
    const route = await router.resolve({
      channel: 'slack',
      accountId: ('team' in event && typeof event.team === 'string') ? event.team : undefined,
      chatId: channelId,
      userId,
    });
    const sessionId = route.sessionId;
    gateway.setSessionWorkspace(sessionId, route.workspacePath);

    try {
      const policy = config.slack?.dmPolicy ?? 'pairing';
      const allowFrom = config.slack?.allowFrom ?? [];
      const paired = await isUserPaired('slack', userId);
      const allowed = isDmAllowedByPolicy({ policy, userId, allowFrom, paired });

      if (!allowed) {
        const request = await createOrGetPairingCode('slack', userId);
        await say({
          text: `🔐 DM pairing required. Your code: ${request.code}\nAsk the owner to run: keygate pairing approve slack ${request.code}`,
        });
        return;
      }
      const attachments = await ingestSlackImageAttachments(
        route.workspacePath,
        sessionId,
        (event as unknown as { files?: unknown }).files,
        botToken,
      );
      if (!text && attachments.length === 0) {
        return;
      }

      await client.reactions.add({ channel: channelId, timestamp: event.ts, name: 'eyes' }).catch(() => {});
      const channel = new SlackChannel(say, channelId, threadTs, userId, false);
      const normalized = normalizeSlackMessage(
        event.ts,
        channelId,
        userId,
        text,
        channel,
        attachments.length > 0 ? attachments : undefined,
        sessionId,
      );

      await gateway.processMessage(normalized);
    } catch (error) {
      console.error('Error processing Slack DM:', error);
      await say({ text: '❌ An error occurred while processing your request.' });
    }
  });

  await app.start();
  console.log('🤖 Slack bot ready! Listening via Socket Mode.');

  return app;
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfigFromEnv();
  startSlackBot(config).catch(console.error);
}

function registerConfirmationActionHandler(app: App): void {
  app.action(CONFIRMATION_ACTION_ID, async ({ ack, body, action, client }) => {
    await ack();

    const decoded = parseConfirmationActionValue((action as { value?: string }).value);
    if (!decoded) {
      return;
    }

    const pending = confirmationBroker.get(decoded.requestId);
    if (!pending) {
      return;
    }

    const actorId = (body as { user?: { id?: string } }).user?.id ?? '';
    const channelId = (body as { channel?: { id?: string } }).channel?.id ?? '';
    const threadTs = getActionThreadTs(body);

    if (
      actorId !== pending.expectedUserId
      || channelId !== pending.channelId
      || threadTs !== pending.threadTs
    ) {
      if (channelId && actorId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: actorId,
          text: 'Only the requesting user can approve this action in the original thread.',
        }).catch(() => {});
      }
      return;
    }

    resolveConfirmationDecision(decoded.requestId, decoded.decision);
  });
}

function resolveConfirmationDecision(requestId: string, decision: ConfirmationDecision): void {
  const pending = confirmationBroker.get(requestId);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timeout);
  confirmationBroker.delete(requestId);
  pending.resolve(decision);
}

function serializeConfirmationActionValue(requestId: string, decision: ConfirmationDecision): string {
  return `${requestId}:${decision}`;
}

function parseConfirmationActionValue(value: string | undefined): { requestId: string; decision: ConfirmationDecision } | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  const [requestId, decisionRaw] = value.split(':', 2);
  if (!requestId) {
    return null;
  }

  if (decisionRaw !== 'allow_once' && decisionRaw !== 'allow_always' && decisionRaw !== 'cancel') {
    return null;
  }

  return {
    requestId,
    decision: decisionRaw,
  };
}

function getActionThreadTs(body: unknown): string {
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  const message = typeof record['message'] === 'object' && record['message'] !== null
    ? record['message'] as Record<string, unknown>
    : {};
  const threadTs = typeof message['thread_ts'] === 'string' ? message['thread_ts'] : undefined;
  const messageTs = typeof message['ts'] === 'string' ? message['ts'] : undefined;
  return threadTs ?? messageTs ?? '';
}

async function ingestSlackImageAttachments(
  workspacePath: string,
  sessionId: string,
  filesValue: unknown,
  botToken: string,
): Promise<MessageAttachment[]> {
  if (!Array.isArray(filesValue) || filesValue.length === 0) {
    return [];
  }

  const attachments: MessageAttachment[] = [];
  for (const fileEntry of filesValue) {
    if (attachments.length >= MAX_MESSAGE_ATTACHMENTS) {
      console.warn(`Ignoring extra Slack attachments for ${sessionId}: exceeded ${MAX_MESSAGE_ATTACHMENTS} images.`);
      break;
    }

    const file = (typeof fileEntry === 'object' && fileEntry !== null ? fileEntry : {}) as SlackFileLike;
    const contentType = normalizeUploadMimeType(file.mimetype);
    if (!IMAGE_UPLOAD_ALLOWED_MIME_TYPES.has(contentType)) {
      if (contentType) {
        console.info(`Ignoring Slack attachment with unsupported type ${contentType} in ${sessionId}.`);
      }
      continue;
    }

    if (typeof file.size === 'number' && file.size > IMAGE_UPLOAD_MAX_BYTES) {
      console.warn(`Ignoring oversized Slack attachment (${file.size} bytes) in ${sessionId}.`);
      continue;
    }

    const downloadUrl = typeof file.url_private_download === 'string'
      ? file.url_private_download
      : typeof file.url_private === 'string'
        ? file.url_private
        : '';
    if (!downloadUrl) {
      continue;
    }

    const response = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${botToken}`,
      },
    });
    if (!response.ok) {
      console.warn(`Failed to download Slack attachment in ${sessionId}: HTTP ${response.status}.`);
      continue;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > IMAGE_UPLOAD_MAX_BYTES) {
      console.warn(`Ignoring oversized Slack attachment payload (${bytes.length} bytes) in ${sessionId}.`);
      continue;
    }

    const attachment = await persistUploadedImage(workspacePath, sessionId, {
      bytes,
      contentType,
      filename: file.name,
    });
    attachments.push(attachment);
  }

  return attachments;
}
