import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type ChatInputCommandInteraction,
  type Message as DiscordMessage,
} from 'discord.js';
import {
  Gateway,
  ATTACHMENT_UPLOAD_ALLOWED_MIME_TYPES,
  ATTACHMENT_UPLOAD_MAX_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
  normalizeDiscordMessage,
  normalizeUploadMimeType,
  persistUploadedAttachment,
  BaseChannel,
  getChannelActionRegistry,
  getBrowserScreenshotAllowedRoots,
  isPathWithinRoot,
  loadConfigFromEnv,
  loadEnvironment,
  resolveSessionScreenshotByFilename,
  sanitizeBrowserScreenshotFilename,
  type ConfirmationDetails,
  type ConfirmationDecision,
  type ChannelActionName,
  type KeygateConfig,
  type MessageAttachment,
  createOrGetPairingCode,
  isDmAllowedByPolicy,
  isUserPaired,
  RoutingRuleStore,
  RoutingService,
} from '@puukis/core';
import { DiscordVoiceManager } from './voiceManager.js';

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

class DiscordInteractionChannel extends BaseChannel {
  type = 'discord' as const;
  private lastUpdateAt = 0;

  constructor(private readonly interaction: ChatInputCommandInteraction) {
    super();
  }

  async send(content: string): Promise<void> {
    const chunks = splitDiscordMessage(content);
    if (!this.interaction.deferred && !this.interaction.replied) {
      await this.interaction.reply(chunks[0] ?? '(No response)');
      for (const chunk of chunks.slice(1)) {
        await this.interaction.followUp(chunk);
      }
      return;
    }

    if (chunks.length > 0) {
      await this.interaction.editReply(chunks[0] ?? '(No response)');
      for (const chunk of chunks.slice(1)) {
        await this.interaction.followUp(chunk);
      }
    }
  }

  async sendStream(stream: AsyncIterable<string>): Promise<void> {
    if (!this.interaction.deferred && !this.interaction.replied) {
      await this.interaction.deferReply();
    }

    let buffer = '';
    for await (const chunk of stream) {
      buffer += chunk;
      const now = Date.now();
      if (now - this.lastUpdateAt > 1000) {
        await this.interaction.editReply(truncateDiscordReply(buffer));
        this.lastUpdateAt = now;
      }
    }

    await this.interaction.editReply(truncateDiscordReply(buffer || '(No response)'));
  }

  async requestConfirmation(prompt: string): Promise<'cancel'> {
    const message = `${prompt}\n\nThis action requires interactive confirmation and cannot be approved from a Discord slash command.`;
    if (!this.interaction.deferred && !this.interaction.replied) {
      await this.interaction.reply({ content: truncateDiscordReply(message), ephemeral: true });
    } else {
      await this.interaction.followUp({ content: truncateDiscordReply(message), ephemeral: true });
    }
    return 'cancel';
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
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
  });

  const gateway = Gateway.getInstance(config);
  const router = new RoutingService(new RoutingRuleStore(), config.security.workspacePath);
  const prefixes = resolveDiscordPrefixes(config.discord?.prefix ?? process.env['DISCORD_PREFIX']);
  const voiceManager = new DiscordVoiceManager(client, config);

  registerDiscordActionAdapter(client, config);

  client.once(Events.ClientReady, (c) => {
    console.log(`🤖 Discord bot ready! Logged in as ${c.user.tag}`);
    
    // Set status based on security mode
    const mode = gateway.getSecurityMode();
    const status = mode === 'spicy' ? '🔴 SPICY MODE' : '🟢 Safe Mode';
    c.user.setActivity(status);
    void registerDiscordSlashCommands(c);
  });

  // Listen for mode changes to update status
  gateway.on('mode:changed', ({ mode }) => {
    const status = mode === 'spicy' ? '🔴 DANGER: SPICY MODE ACTIVE' : '🟢 Safe Mode';
    client.user?.setActivity(status);
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    const isDirectMessage = message.channel.isDMBased();
    const matchedPrefix = findMatchedPrefix(message.content, prefixes);

    if (!isDirectMessage && !matchedPrefix) {
      return;
    }

    const content = isDirectMessage
      ? (matchedPrefix ? message.content.slice(matchedPrefix.length).trim() : message.content.trim())
      : message.content.slice(matchedPrefix!.length).trim();

    try {
      await message.react('👀');
    } catch {
      // Ignore reaction failures (missing perms, rate limits, deleted message).
    }

    try {
      if (isDirectMessage) {
        const policy = config.discord?.dmPolicy ?? 'pairing';
        const allowFrom = config.discord?.allowFrom ?? [];
        const paired = await isUserPaired('discord', message.author.id);
        const allowed = isDmAllowedByPolicy({ policy, userId: message.author.id, allowFrom, paired });

        if (!allowed) {
          const request = await createOrGetPairingCode('discord', message.author.id);
          await message.reply(
            `🔐 DM pairing required. Your code: ${request.code}\n` +
            `Ask the owner to run: keygate pairing approve discord ${request.code}`
          );
          return;
        }
      }
      const route = await router.resolve({
        channel: 'discord',
        accountId: message.guildId ?? undefined,
        chatId: message.channelId,
        userId: message.author.id,
      });
      const sessionId = route.sessionId;
      await gateway.prepareSessionWorkspace(sessionId, route.workspacePath);

      const attachments = await ingestDiscordAttachments(
        route.workspacePath,
        sessionId,
        message,
      );
      if (!content && attachments.length === 0) {
        return;
      }

      const channel = new DiscordChannel(message, browserArtifactsRoot);
      const normalized = normalizeDiscordMessage(
        message.id,
        message.channelId,
        message.author.id,
        content,
        channel,
        attachments.length > 0 ? attachments : undefined,
        sessionId,
      );

      await gateway.processMessage(normalized);
    } catch (error) {
      console.error('Error processing Discord message:', error);
      await message.reply('❌ An error occurred while processing your request.');
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (await voiceManager.handleCommand(interaction)) {
      return;
    }

    const content = buildDiscordSlashCommand(interaction);
    if (!content) {
      return;
    }

    const isDirectMessage = interaction.channel?.isDMBased?.() === true;
    try {
      if (isDirectMessage) {
        const policy = config.discord?.dmPolicy ?? 'pairing';
        const allowFrom = config.discord?.allowFrom ?? [];
        const paired = await isUserPaired('discord', interaction.user.id);
        const allowed = isDmAllowedByPolicy({ policy, userId: interaction.user.id, allowFrom, paired });

        if (!allowed) {
          const request = await createOrGetPairingCode('discord', interaction.user.id);
          await interaction.reply({
            content:
              `🔐 DM pairing required. Your code: ${request.code}\n` +
              `Ask the owner to run: keygate pairing approve discord ${request.code}`,
            ephemeral: true,
          });
          return;
        }
      }

      const route = await router.resolve({
        channel: 'discord',
        accountId: interaction.guildId ?? undefined,
        chatId: interaction.channelId,
        userId: interaction.user.id,
      });
      const sessionId = route.sessionId;
      await gateway.prepareSessionWorkspace(sessionId, route.workspacePath);

      const channel = new DiscordInteractionChannel(interaction);
      const normalized = normalizeDiscordMessage(
        interaction.id,
        interaction.channelId,
        interaction.user.id,
        content,
        channel,
        undefined,
        sessionId,
      );
      await gateway.processMessage(normalized);
    } catch (error) {
      console.error('Error processing Discord slash command:', error);
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({ content: '❌ An error occurred while processing your request.', ephemeral: true }).catch(() => {});
      } else {
        await interaction.followUp({ content: '❌ An error occurred while processing your request.', ephemeral: true }).catch(() => {});
      }
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

async function ingestDiscordAttachments(
  workspacePath: string,
  sessionId: string,
  message: DiscordMessage
): Promise<MessageAttachment[]> {
  if (message.attachments.size === 0) {
    return [];
  }

  const attachments: MessageAttachment[] = [];
  for (const candidate of message.attachments.values()) {
    if (attachments.length >= MAX_MESSAGE_ATTACHMENTS) {
      console.warn(`Ignoring extra Discord attachments for ${sessionId}: exceeded ${MAX_MESSAGE_ATTACHMENTS} files.`);
      break;
    }

    const contentType = normalizeUploadMimeType(candidate.contentType ?? undefined);
    if (!ATTACHMENT_UPLOAD_ALLOWED_MIME_TYPES.has(contentType)) {
      if (contentType) {
        console.info(`Ignoring Discord attachment with unsupported type ${contentType} in ${sessionId}.`);
      }
      continue;
    }

    if (candidate.size > ATTACHMENT_UPLOAD_MAX_BYTES) {
      console.warn(`Ignoring oversized Discord attachment (${candidate.size} bytes) in ${sessionId}.`);
      continue;
    }

    const response = await fetch(candidate.url);
    if (!response.ok) {
      console.warn(`Failed to download Discord attachment in ${sessionId}: HTTP ${response.status}.`);
      continue;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > ATTACHMENT_UPLOAD_MAX_BYTES) {
      console.warn(`Ignoring oversized Discord attachment payload (${bytes.length} bytes) in ${sessionId}.`);
      continue;
    }

    const persisted = await persistUploadedAttachment(workspacePath, sessionId, {
      bytes,
      contentType,
      filename: candidate.name ?? undefined,
    });
    attachments.push(persisted);
  }

  return attachments;
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

async function registerDiscordSlashCommands(client: Client<true> | Client): Promise<void> {
  if (!client.application) {
    return;
  }

  await client.application.commands.set([
    {
      name: 'help',
      description: 'Show available Keygate operator commands.',
    },
    {
      name: 'status',
      description: 'Show current model, tokens, and runtime health.',
    },
    {
      name: 'model',
      description: 'Show or update the session model override.',
      options: [
        {
          name: 'provider',
          description: 'Provider override',
          type: 3,
          required: false,
          choices: [
            { name: 'OpenAI', value: 'openai' },
            { name: 'OpenAI Codex', value: 'openai-codex' },
            { name: 'Gemini', value: 'gemini' },
            { name: 'Ollama', value: 'ollama' },
          ],
        },
        {
          name: 'model',
          description: 'Model id',
          type: 3,
          required: false,
        },
        {
          name: 'reasoning',
          description: 'Reasoning effort for Codex models',
          type: 3,
          required: false,
          choices: [
            { name: 'Low', value: 'low' },
            { name: 'Medium', value: 'medium' },
            { name: 'High', value: 'high' },
            { name: 'Extra High', value: 'xhigh' },
          ],
        },
      ],
    },
    {
      name: 'compact',
      description: 'Summarize the session and keep a short recent tail.',
    },
    {
      name: 'debug',
      description: 'Show or toggle the session debug buffer.',
      options: [
        {
          name: 'state',
          description: 'Turn debug logging on or off',
          type: 3,
          required: false,
          choices: [
            { name: 'On', value: 'on' },
            { name: 'Off', value: 'off' },
          ],
        },
      ],
    },
    {
      name: 'stop',
      description: 'Cancel the active run for this session.',
    },
    {
      name: 'new',
      description: 'Start a fresh session in the current thread.',
    },
    {
      name: 'reset',
      description: 'Reset the session history and local overrides.',
    },
    {
      name: 'voice',
      description: 'Join, leave, or inspect the Discord voice runtime.',
      options: [
        {
          name: 'join',
          description: 'Join the caller’s current voice channel.',
          type: 1,
        },
        {
          name: 'leave',
          description: 'Leave the active voice channel for this guild.',
          type: 1,
        },
        {
          name: 'status',
          description: 'Show the active voice session status.',
          type: 1,
        },
      ],
    },
  ]);
}

function buildDiscordSlashCommand(interaction: ChatInputCommandInteraction): string | null {
  switch (interaction.commandName) {
    case 'help':
    case 'status':
    case 'compact':
    case 'stop':
    case 'new':
    case 'reset':
      return `/${interaction.commandName}`;
    case 'debug': {
      const state = interaction.options.getString('state');
      return state ? `/debug ${state}` : '/debug';
    }
    case 'model': {
      const provider = interaction.options.getString('provider');
      const model = interaction.options.getString('model');
      const reasoning = interaction.options.getString('reasoning');
      const parts = ['/model'];
      if (provider) {
        parts.push(provider);
      }
      if (model) {
        parts.push(model);
      }
      if (reasoning) {
        parts.push(reasoning);
      }
      return parts.join(' ');
    }
    default:
      return null;
  }
}

function registerDiscordActionAdapter(client: Client, config: KeygateConfig): void {
  const gate = config.actions?.discord ?? {
    send: true,
    read: true,
    edit: true,
    delete: true,
    react: true,
    reactions: true,
    poll: true,
    threadCreate: true,
    threadList: true,
    threadReply: true,
  };

  const actions: ChannelActionName[] = [];
  if (gate.send !== false) actions.push('send');
  if (gate.read !== false) actions.push('read');
  if (gate.edit !== false) actions.push('edit');
  if (gate.delete !== false) actions.push('delete');
  if (gate.react !== false) actions.push('react');
  if (gate.reactions !== false) actions.push('reactions');
  if (gate.poll !== false) actions.push('poll');
  if (gate.threadCreate !== false) actions.push('thread-create');
  if (gate.threadList !== false) actions.push('thread-list');
  if (gate.threadReply !== false) actions.push('thread-reply');

  getChannelActionRegistry().register({
    channel: 'discord',
    actions,
    handle: async (ctx) => {
      const channelId = firstStringParam(ctx.params['threadId'], ctx.params['channelId']);
      const messageId = firstStringParam(ctx.params['messageId']);
      const content = firstStringParam(ctx.params['content']) ?? '';

      if (ctx.action === 'thread-reply') {
        const thread = await fetchDiscordTextChannel(client, channelId);
        if (!thread) {
          return { ok: false, channel: 'discord', error: 'Discord threadId or channelId is required.' };
        }
        const sent = await thread.send(content || '(No response)');
        return {
          ok: true,
          channel: 'discord',
          externalMessageId: sent.id,
          threadId: sent.channelId,
          payload: { content, threadId: sent.channelId },
        };
      }

      const targetChannel = await fetchDiscordTextChannel(client, channelId);
      if (!targetChannel) {
        return {
          ok: false,
          channel: 'discord',
          error: 'Discord actions require channelId or threadId.',
        };
      }

      if (ctx.action === 'send') {
        const sent = await targetChannel!.send(content || '(No response)');
        return {
          ok: true,
          channel: 'discord',
          externalMessageId: sent.id,
          threadId: sent.channelId !== targetChannel!.id ? sent.channelId : undefined,
          payload: { content },
        };
      }

      if (ctx.action === 'read') {
        const limit = typeof ctx.params['limit'] === 'number' ? Math.max(1, Math.min(20, Math.floor(ctx.params['limit']))) : 10;
        const messages = await targetChannel!.messages.fetch({ limit });
        return {
          ok: true,
          channel: 'discord',
          payload: {
            messages: Array.from(messages.values() as Iterable<any>).map((message: any) => ({
              id: message.id,
              author: message.author?.tag ?? message.author?.username ?? message.author?.id,
              content: message.content,
              createdAt: message.createdAt.toISOString(),
            })),
          },
        };
      }

      if (!messageId) {
        return {
          ok: false,
          channel: 'discord',
          error: `${ctx.action} requires messageId.`,
        };
      }

      const message = await targetChannel!.messages.fetch(messageId);

      if (ctx.action === 'edit') {
        const edited = await message.edit(content || message.content || '(No response)');
        return {
          ok: true,
          channel: 'discord',
          externalMessageId: edited.id,
          payload: { content: edited.content },
        };
      }

      if (ctx.action === 'delete') {
        await message.delete();
        return {
          ok: true,
          channel: 'discord',
          externalMessageId: message.id,
          payload: { deleted: true },
        };
      }

      if (ctx.action === 'react') {
        const emoji = firstStringParam(ctx.params['emoji']);
        if (!emoji) {
          return { ok: false, channel: 'discord', error: 'Discord react requires emoji.' };
        }
        const reaction = await message.react(emoji);
        return {
          ok: true,
          channel: 'discord',
          externalMessageId: message.id,
          payload: {
            emoji,
            count: reaction.count,
          },
        };
      }

      if (ctx.action === 'reactions') {
        return {
          ok: true,
          channel: 'discord',
          externalMessageId: message.id,
          payload: {
            reactions: message.reactions.cache.map((reaction: any) => ({
              emoji: reaction.emoji.toString(),
              count: reaction.count,
            })),
          },
        };
      }

      if (ctx.action === 'poll') {
        const question = firstStringParam(ctx.params['question']);
        const options = Array.isArray(ctx.params['options'])
          ? ctx.params['options'].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          : [];
        if (!question || options.length < 2) {
          return {
            ok: false,
            channel: 'discord',
            error: 'Discord poll requires a question and at least two options.',
          };
        }
        const sent = await targetChannel!.send({
          poll: {
            question: { text: question },
            answers: options.map((option) => ({ poll_media: { text: option } })),
            allowMultiselect: ctx.params['multiple'] === true,
            duration: 24,
          },
        } as any);
        return {
          ok: true,
          channel: 'discord',
          externalMessageId: sent.id,
          pollId: sent.id,
          payload: {
            question,
            options,
            multiple: ctx.params['multiple'] === true,
          },
        };
      }

      if (ctx.action === 'thread-create') {
        const name = firstStringParam(ctx.params['name']) ?? `Thread ${new Date().toLocaleString()}`;
        const thread = await (targetChannel as any).threads.create({
          name,
          ...(messageId ? { startMessage: messageId } : {}),
          autoArchiveDuration: 60,
        });
        return {
          ok: true,
          channel: 'discord',
          threadId: thread.id,
          payload: { name, threadId: thread.id },
        };
      }

      if (ctx.action === 'thread-list') {
        const listing = await (targetChannel as any).threads.fetchActive();
        return {
          ok: true,
          channel: 'discord',
          payload: {
            threads: Array.from(listing.threads.values()).map((thread: any) => ({
              id: thread.id,
              name: thread.name,
              archived: thread.archived,
            })),
          },
        };
      }

      return {
        ok: false,
        channel: 'discord',
        error: `${ctx.action} is not supported for Discord.`,
      };
    },
  });
}

async function fetchDiscordTextChannel(client: Client, channelId: string | undefined): Promise<any | null> {
  if (!channelId) {
    return null;
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel || typeof (channel as { send?: unknown }).send !== 'function') {
    return null;
  }
  return channel as any;
}

function firstStringParam(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function splitDiscordMessage(content: string, maxLength = 1900): string[] {
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

function truncateDiscordReply(content: string): string {
  return content.length > 1900 ? `${content.slice(0, 1900)}...(truncated)` : content;
}
