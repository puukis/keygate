import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Readable } from 'node:stream';
import OpenAI from 'openai';
import {
  AudioPlayerStatus,
  EndBehaviorType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import {
  BaseChannel,
  Gateway,
  RoutingRuleStore,
  RoutingService,
  normalizeDiscordMessage,
  type ConfirmationDecision,
  type ConfirmationDetails,
  type KeygateConfig,
} from '@puukis/core';
import type {
  Channel,
  ChatInputCommandInteraction,
  Client,
  GuildTextBasedChannel,
  VoiceBasedChannel,
} from 'discord.js';

const require = createRequire(import.meta.url);

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BIT_DEPTH = 16;
const PLAYBACK_READY_TIMEOUT_MS = 15_000;
const DECRYPT_FAILURE_WINDOW_MS = 30_000;
const DECRYPT_FAILURE_REJOIN_THRESHOLD = 3;
const DECRYPT_FAILURE_PATTERN = /DecryptionFailed\(/;

type OpusDecoder = {
  decode: (buffer: Buffer) => Buffer;
};

type VoiceSession = {
  guildId: string;
  voiceChannelId: string;
  controlChannelId: string;
  sessionId: string;
  workspacePath: string;
  controlChannel: GuildTextBasedChannel;
  connection: VoiceConnection;
  player: AudioPlayer;
  activeSpeakers: Set<string>;
  decryptFailureCount: number;
  lastDecryptFailureAt: number;
  rejoinInFlight: boolean;
};

class DiscordVoiceReplyChannel extends BaseChannel {
  type = 'discord' as const;

  constructor(
    private readonly session: VoiceSession,
    private readonly manager: DiscordVoiceManager,
  ) {
    super();
  }

  async send(content: string): Promise<void> {
    const trimmed = content.trim() || '(No response)';
    await this.manager.sendControlText(this.session, trimmed);
    await this.manager.playVoiceReply(this.session, trimmed);
  }

  async sendStream(stream: AsyncIterable<string>): Promise<void> {
    let buffer = '';
    for await (const chunk of stream) {
      buffer += chunk;
    }
    await this.send(buffer || '(No response)');
  }

  async requestConfirmation(prompt: string, details?: ConfirmationDetails): Promise<ConfirmationDecision> {
    const extra = [
      details?.summary ? `Summary: ${details.summary}` : '',
      details?.command ? `Command: ${details.command}` : '',
      details?.cwd ? `CWD: ${details.cwd}` : '',
      details?.path ? `Path: ${details.path}` : '',
    ].filter(Boolean);
    await this.manager.sendControlText(
      this.session,
      `${prompt}\n\n${extra.join('\n')}\n\nVoice sessions cannot approve tool confirmations inline. Re-run this from text chat.`,
    );
    return 'cancel';
  }
}

export class DiscordVoiceManager {
  private readonly gateway: Gateway;
  private readonly router: RoutingService;
  private readonly sessions = new Map<string, VoiceSession>();
  private readonly openai: OpenAI | null;
  private readonly voiceConfig: NonNullable<NonNullable<KeygateConfig['discord']>['voice']>;

  constructor(
    private readonly client: Client,
    private readonly config: KeygateConfig,
  ) {
    this.gateway = Gateway.getInstance(config);
    this.router = new RoutingService(new RoutingRuleStore(), config.security.workspacePath);
    this.voiceConfig = config.discord?.voice ?? {
      enabled: true,
      silenceDurationMs: 1_000,
      minSegmentMs: 450,
      playbackVolume: 1,
      ttsEnabled: true,
      controlChannelMode: 'reply',
    };
    const apiKey = process.env['OPENAI_API_KEY']?.trim() || config.llm.apiKey?.trim();
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
  }

  isEnabled(): boolean {
    return this.voiceConfig.enabled !== false;
  }

  async handleCommand(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (interaction.commandName !== 'voice') {
      return false;
    }

    const subcommand = interaction.options.getSubcommand(true);
    if (subcommand === 'join') {
      await this.join(interaction);
      return true;
    }
    if (subcommand === 'leave') {
      await this.leave(interaction);
      return true;
    }
    await this.status(interaction);
    return true;
  }

  async destroy(): Promise<void> {
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    for (const session of sessions) {
      try {
        session.player.stop(true);
      } catch {
        // ignore
      }
      try {
        session.connection.destroy();
      } catch {
        // ignore
      }
      this.gateway.emit('voice:session', {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.voiceChannelId,
        status: 'left',
      });
    }
  }

  async sendControlText(session: VoiceSession, content: string): Promise<void> {
    for (const chunk of splitDiscordMessage(content)) {
      await session.controlChannel.send(chunk);
    }
  }

  async playVoiceReply(session: VoiceSession, content: string): Promise<void> {
    if (!this.voiceConfig.ttsEnabled || !this.openai || content.trim().length === 0) {
      return;
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-discord-tts-'));
    const filePath = path.join(tempDir, `voice-${Date.now()}.mp3`);
    try {
      const response = await this.openai.audio.speech.create({
        model: this.config.media?.openai?.ttsModel ?? 'gpt-4o-mini-tts',
        voice: this.config.media?.openai?.ttsVoice ?? 'alloy',
        input: content,
        format: 'mp3',
      } as never);
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(filePath, buffer);
      const resource = createAudioResource(createReadStream(filePath), {
        inlineVolume: true,
      });
      if (resource.volume) {
        resource.volume.setVolume(this.voiceConfig.playbackVolume);
      }
      session.player.play(resource);
      await entersState(session.player, AudioPlayerStatus.Playing, PLAYBACK_READY_TIMEOUT_MS);
      await entersState(session.player, AudioPlayerStatus.Idle, Math.max(PLAYBACK_READY_TIMEOUT_MS, Math.ceil(buffer.length / 8)));
    } catch (error) {
      this.gateway.emit('voice:session', {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.voiceChannelId,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async join(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.isEnabled()) {
      await replyEphemeral(interaction, 'Discord voice is disabled in config.');
      return;
    }

    const guild = interaction.guild;
    const member = interaction.member;
    const controlChannel = interaction.channel;
    if (!guild || !member || !controlChannel || !isTextSendable(controlChannel)) {
      await replyEphemeral(interaction, 'Voice join must be used from a guild text channel.');
      return;
    }

    const voiceChannel = resolveVoiceChannel(member);
    if (!voiceChannel) {
      await replyEphemeral(interaction, 'Join a voice channel first, then run `/voice join`.');
      return;
    }

    const existing = this.sessions.get(guild.id);
    if (existing) {
      if (existing.voiceChannelId === voiceChannel.id) {
        await replyEphemeral(interaction, `Already joined <#${voiceChannel.id}>.`);
        return;
      }
      await this.closeSession(existing, 'Switching voice channel.');
    }

    const route = await this.router.resolve({
      channel: 'discord',
      accountId: interaction.guildId ?? undefined,
      chatId: interaction.channelId,
      userId: interaction.user.id,
    });
    await this.gateway.prepareSessionWorkspace(route.sessionId, route.workspacePath);

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, PLAYBACK_READY_TIMEOUT_MS);

    const player = createAudioPlayer();
    connection.subscribe(player);

    const session: VoiceSession = {
      guildId: guild.id,
      voiceChannelId: voiceChannel.id,
      controlChannelId: interaction.channelId,
      sessionId: route.sessionId,
      workspacePath: route.workspacePath,
      controlChannel,
      connection,
      player,
      activeSpeakers: new Set<string>(),
      decryptFailureCount: 0,
      lastDecryptFailureAt: 0,
      rejoinInFlight: false,
    };
    this.sessions.set(guild.id, session);
    this.attachSession(session);
    this.gateway.emit('voice:session', {
      sessionId: session.sessionId,
      guildId: session.guildId,
      channelId: session.voiceChannelId,
      status: 'joined',
    });

    await replyEphemeral(
      interaction,
      `Joined ${voiceChannel.toString()} and bound it to session \`${route.sessionId}\`. Voice turns will mirror into ${controlChannel.toString()}.`,
    );
  }

  private async leave(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId ?? '';
    const session = guildId ? this.sessions.get(guildId) : undefined;
    if (!session) {
      await replyEphemeral(interaction, 'No active Discord voice session.');
      return;
    }

    await this.closeSession(session, 'Voice session closed.');
    await replyEphemeral(interaction, 'Left the active voice channel.');
  }

  private async status(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId ?? '';
    const session = guildId ? this.sessions.get(guildId) : undefined;
    if (!session) {
      await replyEphemeral(interaction, 'No active Discord voice session.');
      return;
    }

    await replyEphemeral(
      interaction,
      `Voice active in <#${session.voiceChannelId}>.\nControl channel: <#${session.controlChannelId}>\nSession: \`${session.sessionId}\`\nActive speakers: ${session.activeSpeakers.size}`,
    );
  }

  private attachSession(session: VoiceSession): void {
    session.connection.receiver.speaking.on('start', (userId) => {
      if (userId === this.client.user?.id || session.activeSpeakers.has(userId)) {
        return;
      }
      session.activeSpeakers.add(userId);
      const stream = session.connection.receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: this.voiceConfig.silenceDurationMs,
        },
      });
      stream.on('error', (error) => {
        this.noteDecryptFailure(session, error);
      });
      void this.handleSpeakerTurn(session, userId, stream).finally(() => {
        session.activeSpeakers.delete(userId);
      });
    });

    session.connection.on('error', (error) => {
      this.noteDecryptFailure(session, error);
      this.gateway.emit('voice:session', {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.voiceChannelId,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    });

    session.connection.on(VoiceConnectionStatus.Disconnected, () => {
      this.gateway.emit('voice:session', {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.voiceChannelId,
        status: 'error',
        error: 'Voice connection disconnected.',
      });
    });
  }

  private async handleSpeakerTurn(
    session: VoiceSession,
    userId: string,
    stream: Readable,
  ): Promise<void> {
    this.gateway.emit('voice:session', {
      sessionId: session.sessionId,
      guildId: session.guildId,
      channelId: session.voiceChannelId,
      status: 'speaking',
    });

    const pcm = await decodeOpusStream(stream);
    const durationMs = estimateDurationMs(pcm);
    if (!pcm.length || durationMs < this.voiceConfig.minSegmentMs) {
      this.gateway.emit('voice:session', {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.voiceChannelId,
        status: 'idle',
      });
      return;
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-discord-voice-'));
    const wavPath = path.join(tempDir, `segment-${randomUUID()}.wav`);
    try {
      await fs.writeFile(wavPath, buildWavBuffer(pcm));
      const transcript = await this.transcribeWav(wavPath);
      if (!transcript) {
        return;
      }

      const speakerName = await this.resolveSpeakerName(session.guildId, userId);
      await this.sendControlText(session, `🎙️ **${speakerName}:** ${transcript}`);
      const channel = new DiscordVoiceReplyChannel(session, this);
      const normalized = normalizeDiscordMessage(
        `voice:${randomUUID()}`,
        session.controlChannelId,
        userId,
        transcript,
        channel,
        undefined,
        session.sessionId,
      );
      await this.gateway.processMessage({
        ...normalized,
        metadata: {
          source: 'discord.voice',
          guildId: session.guildId,
          voiceChannelId: session.voiceChannelId,
          controlChannelId: session.controlChannelId,
          speakerId: userId,
          speakerName,
        },
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      this.gateway.emit('voice:session', {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.voiceChannelId,
        status: 'idle',
      });
    }
  }

  private async transcribeWav(filePath: string): Promise<string | null> {
    if (!this.openai) {
      return null;
    }
    try {
      const result = await this.openai.audio.transcriptions.create({
        file: createReadStream(filePath),
        model: this.config.media?.openai?.transcriptionModel ?? 'gpt-4o-mini-transcribe',
      } as never);
      const text = typeof result === 'object' && result && 'text' in result
        ? String((result as { text?: unknown }).text ?? '').trim()
        : '';
      return text || null;
    } catch {
      return null;
    }
  }

  private async resolveSpeakerName(guildId: string, userId: string): Promise<string> {
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const member = await guild.members.fetch(userId);
      return member.displayName || member.user.username || userId;
    } catch {
      return userId;
    }
  }

  private noteDecryptFailure(session: VoiceSession, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (!DECRYPT_FAILURE_PATTERN.test(message)) {
      return;
    }
    const now = Date.now();
    if (now - session.lastDecryptFailureAt > DECRYPT_FAILURE_WINDOW_MS) {
      session.decryptFailureCount = 0;
    }
    session.lastDecryptFailureAt = now;
    session.decryptFailureCount += 1;
    if (session.decryptFailureCount >= DECRYPT_FAILURE_REJOIN_THRESHOLD) {
      void this.rejoin(session);
    }
  }

  private async rejoin(session: VoiceSession): Promise<void> {
    if (session.rejoinInFlight) {
      return;
    }
    session.rejoinInFlight = true;
    try {
      session.connection.rejoin({
        channelId: session.voiceChannelId,
        selfDeaf: false,
        selfMute: false,
      });
      await entersState(session.connection, VoiceConnectionStatus.Ready, PLAYBACK_READY_TIMEOUT_MS);
      session.decryptFailureCount = 0;
    } catch (error) {
      this.gateway.emit('voice:session', {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.voiceChannelId,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      session.rejoinInFlight = false;
    }
  }

  private async closeSession(session: VoiceSession, notice?: string): Promise<void> {
    this.sessions.delete(session.guildId);
    try {
      session.player.stop(true);
    } catch {
      // ignore
    }
    try {
      session.connection.destroy();
    } catch {
      // ignore
    }
    this.gateway.emit('voice:session', {
      sessionId: session.sessionId,
      guildId: session.guildId,
      channelId: session.voiceChannelId,
      status: 'left',
    });
    if (notice) {
      await this.sendControlText(session, `🔇 ${notice}`);
    }
  }
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

  return chunks.length > 0 ? chunks : ['(No response)'];
}

function resolveVoiceChannel(member: unknown): VoiceBasedChannel | null {
  if (!member || typeof member !== 'object' || !('voice' in member)) {
    return null;
  }
  const voice = (member as { voice?: { channel?: VoiceBasedChannel | null } }).voice;
  return voice?.channel ?? null;
}

function isTextSendable(channel: Channel): channel is GuildTextBasedChannel {
  return typeof (channel as GuildTextBasedChannel).send === 'function';
}

async function replyEphemeral(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.reply({ content, ephemeral: true });
    return;
  }
  await interaction.followUp({ content, ephemeral: true });
}

function createOpusDecoder(): OpusDecoder | null {
  try {
    const OpusScript = require('opusscript') as {
      new (sampleRate: number, channels: number, application: number): OpusDecoder;
      Application: { AUDIO: number };
    };
    return new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
  } catch {
    return null;
  }
}

async function decodeOpusStream(stream: Readable): Promise<Buffer> {
  const decoder = createOpusDecoder();
  if (!decoder) {
    return Buffer.alloc(0);
  }

  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) {
      if (!(chunk instanceof Buffer) || chunk.length === 0) {
        continue;
      }
      const decoded = decoder.decode(chunk);
      if (decoded.length > 0) {
        chunks.push(Buffer.from(decoded));
      }
    }
  } catch {
    return Buffer.alloc(0);
  }

  return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
}

function buildWavBuffer(pcm: Buffer): Buffer {
  const blockAlign = (CHANNELS * BIT_DEPTH) / 8;
  const byteRate = SAMPLE_RATE * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BIT_DEPTH, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function estimateDurationMs(pcm: Buffer): number {
  const bytesPerSample = (BIT_DEPTH / 8) * CHANNELS;
  if (bytesPerSample <= 0) {
    return 0;
  }
  return Math.round((pcm.length / (bytesPerSample * SAMPLE_RATE)) * 1000);
}
