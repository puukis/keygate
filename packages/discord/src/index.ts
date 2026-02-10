import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message as DiscordMessage,
} from 'discord.js';
import {
  Gateway,
  normalizeDiscordMessage,
  BaseChannel,
  getBrowserScreenshotAllowedRoots,
  isPathWithinRoot,
  loadConfigFromEnv,
  loadEnvironment,
  resolveSessionScreenshotByFilename,
  sanitizeBrowserScreenshotFilename,
  type ConfirmationDetails,
  type ConfirmationDecision,
  type KeygateConfig,
} from '@puukis/core';

loadEnvironment();

const PREFIX = '!keygate ';
const SCREENSHOT_FILENAME_GLOBAL_PATTERN = /session-[A-Za-z0-9:_-]+-step-\d+\.png/gi;
const DISCORD_MAX_ATTACHMENTS_PER_MESSAGE = 10;
type SendableChannel = { send: (...args: any[]) => Promise<unknown> };

/**
 * Discord Channel adapter implementing the Channel interface
 */
class DiscordChannel extends BaseChannel {
  type = 'discord' as const;
  private message: DiscordMessage;
  private replyMessage: DiscordMessage | null = null;
  private artifactsRoot: string;

  constructor(message: DiscordMessage, artifactsRoot: string) {
    super();
    this.message = message;
    this.artifactsRoot = artifactsRoot;
  }


  async send(content: string): Promise<void> {
    const sendableChannel = this.getSendableChannel();

    // Discord has a 2000 char limit, split if needed
    const chunks = this.splitMessage(content);
    for (const chunk of chunks) {
      if (this.replyMessage) {
        if (sendableChannel) {
          await sendableChannel.send(chunk);
        }
      } else {
        this.replyMessage = await this.message.reply(chunk);
      }
    }

    await this.sendScreenshotAttachments(content);
  }

  async sendStream(stream: AsyncIterable<string>): Promise<void> {
    let buffer = '';
    let lastUpdate = Date.now();
    const updateInterval = 1000; // Update every second

    // Send initial "thinking" message
    this.replyMessage = await this.message.reply('🤔 Thinking...');

    for await (const chunk of stream) {
      buffer += chunk;

      // Throttle updates to avoid rate limits
      if (Date.now() - lastUpdate > updateInterval) {
        await this.updateReply(buffer);
        lastUpdate = Date.now();
      }
    }

    // Final update
    await this.updateReply(buffer || '(No response)');
    await this.sendScreenshotAttachments(buffer);
  }

  async requestConfirmation(prompt: string, details?: ConfirmationDetails): Promise<ConfirmationDecision> {
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

    const confirmMsg = await this.message.reply(
      `${prompt}${detailLines.length > 0 ? `\n\n${detailLines.join('\n')}` : ''}\n\nReact with ✅ allow once, ♾️ allow always, or ❌ cancel.`
    );

    await confirmMsg.react('✅');
    await confirmMsg.react('♾️');
    await confirmMsg.react('❌');

    try {
      const collected = await confirmMsg.awaitReactions({
        filter: (reaction, user) =>
          ['✅', '♾️', '♾', '❌'].includes(reaction.emoji.name ?? '') &&
          user.id === this.message.author.id,
        max: 1,
        time: 60000, // 1 minute timeout
        errors: ['time'],
      });

      const reaction = collected.first();
      const emoji = reaction?.emoji.name;
      if (emoji === '✅') {
        return 'allow_once';
      }
      if (emoji === '♾️' || emoji === '♾') {
        return 'allow_always';
      }
      return 'cancel';
    } catch {
      try {
        await this.message.reply('⏱️ Confirmation timed out. Please run your request again.');
      } catch {
        // Ignore timeout notification failures.
      }
      return 'cancel'; // Timeout = reject
    }
  }

  private async updateReply(content: string): Promise<void> {
    if (!this.replyMessage) return;

    const truncated = content.length > 1900
      ? content.slice(0, 1900) + '...(truncated)'
      : content;

    try {
      await this.replyMessage.edit(truncated);
    } catch {
      // Message might have been deleted
    }
  }

  private splitMessage(content: string, maxLength = 1900): string[] {
    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Find a good break point
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

  private getSendableChannel(): SendableChannel | null {
    const channel = this.message.channel as { send?: (...args: any[]) => Promise<unknown> } | null;
    if (!channel || typeof channel.send !== 'function') {
      return null;
    }
    return channel as SendableChannel;
  }

  private extractScreenshotFilenames(content: string): string[] {
    const filenames: string[] = [];
    const seen = new Set<string>();

    let match: RegExpExecArray | null = null;
    SCREENSHOT_FILENAME_GLOBAL_PATTERN.lastIndex = 0;

    while ((match = SCREENSHOT_FILENAME_GLOBAL_PATTERN.exec(content)) !== null) {
      const candidate = match[0] ?? '';
      const filename = sanitizeBrowserScreenshotFilename(candidate);
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
    const sendableChannel = this.getSendableChannel();
    if (!sendableChannel) {
      return;
    }

    const filenames = this.extractScreenshotFilenames(content);
    if (filenames.length === 0) {
      return;
    }

    const [artifactsRoot, workspaceRoot] = getBrowserScreenshotAllowedRoots(this.artifactsRoot);
    const files: Array<{ attachment: string; name: string }> = [];

    for (const filename of filenames) {
      const resolvedPath = await resolveSessionScreenshotByFilename(this.artifactsRoot, filename);
      if (!resolvedPath) {
        continue;
      }

      if (
        !isPathWithinRoot(artifactsRoot, resolvedPath) &&
        !isPathWithinRoot(workspaceRoot, resolvedPath)
      ) {
        continue;
      }

      files.push({ attachment: resolvedPath, name: filename });
    }

    if (files.length === 0) {
      return;
    }

    for (let i = 0; i < files.length; i += DISCORD_MAX_ATTACHMENTS_PER_MESSAGE) {
      const chunk = files.slice(i, i + DISCORD_MAX_ATTACHMENTS_PER_MESSAGE);
      const label = chunk.length === 1
        ? `Attached browser screenshot: \`${chunk[0]!.name}\``
        : `Attached browser screenshots: ${chunk.map((file) => `\`${file.name}\``).join(', ')}`;

      await sendableChannel.send({
        content: label,
        files: chunk,
      });
    }
  }
}

/**
 * Start the Discord bot
 */
export async function startDiscordBot(config: KeygateConfig): Promise<Client> {
  const token = config.discord?.token ?? process.env['DISCORD_TOKEN'];
  const browserArtifactsRoot = config.browser.artifactsPath;
  
  if (!token) {
    throw new Error('Discord token not configured. Set DISCORD_TOKEN or provide in config.');
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
  });

  const gateway = Gateway.getInstance(config);
  const prefixes = resolveDiscordPrefixes(config.discord?.prefix ?? process.env['DISCORD_PREFIX']);

  client.once(Events.ClientReady, (c) => {
    console.log(`🤖 Discord bot ready! Logged in as ${c.user.tag}`);
    
    // Set status based on security mode
    const mode = gateway.getSecurityMode();
    const status = mode === 'spicy' ? '🔴 SPICY MODE' : '🟢 Safe Mode';
    c.user.setActivity(status);
  });

  // Listen for mode changes to update status
  gateway.on('mode:changed', ({ mode }) => {
    const status = mode === 'spicy' ? '🔴 DANGER: SPICY MODE ACTIVE' : '🟢 Safe Mode';
    client.user?.setActivity(status);
  });

  client.on(Events.MessageCreate, async (message) => {
    // Ignore bots and messages without prefix
    if (message.author.bot) return;

    try {
      await message.react('👀');
    } catch {
      // Ignore reaction failures (missing perms, rate limits, deleted message).
    }

    const matchedPrefix = findMatchedPrefix(message.content, prefixes);
    if (!matchedPrefix) return;

    const content = message.content.slice(matchedPrefix.length).trim();
    if (!content) return;

    try {
      const channel = new DiscordChannel(message, browserArtifactsRoot);
      const normalized = normalizeDiscordMessage(
        message.id,
        message.channelId,
        message.author.id,
        content,
        channel
      );

      await gateway.processMessage(normalized);
    } catch (error) {
      console.error('Error processing Discord message:', error);
      await message.reply('❌ An error occurred while processing your request.');
    }
  });

  await client.login(token);
  return client;
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfigFromEnv();

  startDiscordBot(config).catch(console.error);
}

function resolveDiscordPrefixes(value: string | undefined): string[] {
  const parsed = parseDiscordPrefixes(value);
  if (parsed.length === 0) {
    return [PREFIX];
  }

  // Longest prefixes first to prefer more specific command matches.
  return parsed.sort((left, right) => right.length - left.length);
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

function findMatchedPrefix(content: string, prefixes: string[]): string | null {
  for (const prefix of prefixes) {
    if (content.startsWith(prefix)) {
      return prefix;
    }
  }

  return null;
}
