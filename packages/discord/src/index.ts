import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message as DiscordMessage,
  type TextChannel,
} from 'discord.js';
import {
  Gateway,
  normalizeDiscordMessage,
  BaseChannel,
  loadEnvironment,
  type ConfirmationDetails,
  type ConfirmationDecision,
  type KeygateConfig,
} from '@puukis/core';

loadEnvironment();

const PREFIX = '!keygate ';

/**
 * Discord Channel adapter implementing the Channel interface
 */
class DiscordChannel extends BaseChannel {
  type = 'discord' as const;
  private message: DiscordMessage;
  private replyMessage: DiscordMessage | null = null;

  constructor(message: DiscordMessage) {
    super();
    this.message = message;
  }


  async send(content: string): Promise<void> {
    // Discord has a 2000 char limit, split if needed
    const chunks = this.splitMessage(content);
    for (const chunk of chunks) {
      if (this.replyMessage) {
        // Check if channel is a text-based channel with send method
        if ('send' in this.message.channel) {
          await this.message.channel.send(chunk);
        }
      } else {
        this.replyMessage = await this.message.reply(chunk);
      }
    }
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
}

/**
 * Start the Discord bot
 */
export async function startDiscordBot(config: KeygateConfig): Promise<Client> {
  const token = config.discord?.token ?? process.env['DISCORD_TOKEN'];
  
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
      const channel = new DiscordChannel(message);
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
  // TODO: Load config from file
  const config: KeygateConfig = {
    llm: {
      provider: (process.env['LLM_PROVIDER'] as 'openai' | 'gemini' | 'ollama' | 'openai-codex') ?? 'openai',
      model: process.env['LLM_MODEL'] ?? 'gpt-4o',
      apiKey: process.env['LLM_API_KEY'] ?? '',
      ollama: {
        host: process.env['LLM_OLLAMA_HOST'] ?? 'http://127.0.0.1:11434',
      },
    },
    security: {
      mode: 'safe',
      spicyModeEnabled: process.env['SPICY_MODE_ENABLED'] === 'true',
      spicyMaxObedienceEnabled: process.env['SPICY_MAX_OBEDIENCE_ENABLED'] === 'true',
      workspacePath: process.env['WORKSPACE_PATH'] ?? '~/keygate-workspace',
      allowedBinaries: ['git', 'ls', 'npm', 'cat', 'node', 'python3'],
    },
    server: {
      port: 18790,
    },
    discord: {
      token: process.env['DISCORD_TOKEN'] ?? '',
      prefix: resolveDiscordPrefixes(process.env['DISCORD_PREFIX']).join(', '),
    },
  };

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
