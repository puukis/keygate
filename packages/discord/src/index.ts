import {
  Client,
  Events,
  GatewayIntentBits,
  type Message as DiscordMessage,
  type TextChannel,
} from 'discord.js';
import {
  Gateway,
  normalizeDiscordMessage,
  BaseChannel,
  type KeygateConfig,
} from '@keygate/core';
import path from 'node:path';
import os from 'node:os';
import dotenv from 'dotenv';

// Try to load from ~/.config/keygate/.env first
const configDir = path.join(os.homedir(), '.config', 'keygate');
dotenv.config({ path: path.join(configDir, '.env') });
// Fallback to default behavior (CWD)
dotenv.config();

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

  async requestConfirmation(prompt: string): Promise<boolean> {
    const confirmMsg = await this.message.reply(
      `${prompt}\n\nReact with ✅ to confirm or ❌ to cancel.`
    );

    await confirmMsg.react('✅');
    await confirmMsg.react('❌');

    try {
      const collected = await confirmMsg.awaitReactions({
        filter: (reaction, user) =>
          ['✅', '❌'].includes(reaction.emoji.name ?? '') &&
          user.id === this.message.author.id,
        max: 1,
        time: 60000, // 1 minute timeout
      });

      const reaction = collected.first();
      return reaction?.emoji.name === '✅';
    } catch {
      return false; // Timeout = reject
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
    ],
  });

  const gateway = Gateway.getInstance(config);
  const prefix = config.discord?.prefix ?? PREFIX;

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
    if (!message.content.startsWith(prefix)) return;

    const content = message.content.slice(prefix.length).trim();
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
      workspacePath: process.env['WORKSPACE_PATH'] ?? '~/keygate-workspace',
      allowedBinaries: ['git', 'ls', 'npm', 'cat', 'node', 'python3'],
    },
    server: {
      port: 18790,
    },
    discord: {
      token: process.env['DISCORD_TOKEN'] ?? '',
      prefix: '!keygate ',
    },
  };

  startDiscordBot(config).catch(console.error);
}
