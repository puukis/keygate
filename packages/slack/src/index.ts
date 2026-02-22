import { App, type SayFn } from '@slack/bolt';
import {
  Gateway,
  normalizeSlackMessage,
  BaseChannel,
  loadConfigFromEnv,
  loadEnvironment,
  type ConfirmationDetails,
  type ConfirmationDecision,
  type KeygateConfig,
} from '@puukis/core';

loadEnvironment();

const SLACK_MAX_MESSAGE_LENGTH = 3000;

/**
 * Slack Channel adapter implementing the Channel interface
 */
class SlackChannel extends BaseChannel {
  type = 'slack' as const;
  private say: SayFn;
  private threadTs: string;
  private channelId: string;

  constructor(say: SayFn, channelId: string, threadTs: string) {
    super();
    this.say = say;
    this.channelId = channelId;
    this.threadTs = threadTs;
  }

  async send(content: string): Promise<void> {
    const chunks = this.splitMessage(content);
    for (const chunk of chunks) {
      await this.say({
        text: chunk,
        thread_ts: this.threadTs,
      });
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
      await this.say({
        text: chunk,
        thread_ts: this.threadTs,
      });
    }
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

    const actionId = `confirm_${Date.now()}`;
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
        block_id: actionId,
        elements: [
          {
            type: 'button' as const,
            text: { type: 'plain_text' as const, text: '✅ Allow Once' },
            action_id: `${actionId}_allow_once`,
            style: 'primary' as const,
            value: 'allow_once',
          },
          {
            type: 'button' as const,
            text: { type: 'plain_text' as const, text: '♾️ Allow Always' },
            action_id: `${actionId}_allow_always`,
            value: 'allow_always',
          },
          {
            type: 'button' as const,
            text: { type: 'plain_text' as const, text: '❌ Cancel' },
            action_id: `${actionId}_cancel`,
            style: 'danger' as const,
            value: 'cancel',
          },
        ],
      },
    ];

    await this.say({
      text: prompt,
      blocks,
      thread_ts: this.threadTs,
    });

    // For now, auto-approve in Socket Mode since interactive block handling
    // requires additional wiring. A production deployment should register
    // action handlers on the Bolt app and resolve this promise on click.
    return 'allow_once';
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

  // Respond to direct mentions
  app.event('app_mention', async ({ event, say, client }) => {
    const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!text) return;

    const threadTs = event.thread_ts ?? event.ts;
    const channelId = event.channel;
    const userId = event.user ?? '';

    try {
      await client.reactions.add({ channel: channelId, timestamp: event.ts, name: 'eyes' }).catch(() => {});
      const channel = new SlackChannel(say, channelId, threadTs);
      const normalized = normalizeSlackMessage(
        event.ts,
        channelId,
        userId,
        text,
        channel
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
    if (!text) return;

    const threadTs = ('thread_ts' in event && typeof event.thread_ts === 'string' ? event.thread_ts : undefined) ?? event.ts;
    const channelId = event.channel;
    const userId = 'user' in event ? (event.user ?? '') : '';

    try {
      await client.reactions.add({ channel: channelId, timestamp: event.ts, name: 'eyes' }).catch(() => {});
      const channel = new SlackChannel(say, channelId, threadTs);
      const normalized = normalizeSlackMessage(
        event.ts,
        channelId,
        userId,
        text,
        channel
      );

      await gateway.processMessage(normalized);
    } catch (error) {
      console.error('Error processing Slack DM:', error);
      await say({ text: '❌ An error occurred while processing your request.', thread_ts: threadTs });
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
