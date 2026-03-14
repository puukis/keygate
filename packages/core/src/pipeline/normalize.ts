import type { Channel, ChannelType, MessageAttachment, NormalizedMessage } from '../types.js';
import { randomUUID } from 'node:crypto';

export function resolveWebChatSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed) {
    return `webchat:${randomUUID()}`;
  }
  return trimmed.startsWith('webchat:') ? trimmed : `webchat:${trimmed}`;
}

/**
 * Create a normalized message from Discord
 */
export function normalizeDiscordMessage(
  messageId: string,
  channelId: string,
  userId: string,
  content: string,
  channel: Channel,
  attachments?: MessageAttachment[],
  explicitSessionId?: string,
): NormalizedMessage {
  return {
    id: messageId,
    sessionId: explicitSessionId ?? `discord:${channelId}`,
    channelType: 'discord',
    channel,
    userId,
    content,
    attachments,
    timestamp: new Date(),
  };
}

/**
 * Create a normalized message from Web
 */
export function normalizeWebMessage(
  sessionId: string,
  userId: string,
  content: string,
  channel: Channel,
  attachments?: MessageAttachment[]
): NormalizedMessage {
  return {
    id: randomUUID(),
    sessionId: `web:${sessionId}`,
    channelType: 'web',
    channel,
    userId,
    content,
    attachments,
    timestamp: new Date(),
  };
}

/**
 * Create a normalized message from WebChat guest clients
 */
export function normalizeWebChatMessage(
  sessionId: string,
  userId: string,
  content: string,
  channel: Channel,
  attachments?: MessageAttachment[]
): NormalizedMessage {
  return {
    id: randomUUID(),
    sessionId: resolveWebChatSessionId(sessionId),
    channelType: 'webchat',
    channel,
    userId,
    content,
    attachments,
    timestamp: new Date(),
  };
}

/**
 * Create a normalized message from Terminal UI
 */
export function normalizeTerminalMessage(
  sessionId: string,
  userId: string,
  content: string,
  channel: Channel
): NormalizedMessage {
  return {
    id: randomUUID(),
    sessionId: `terminal:${sessionId}`,
    channelType: 'terminal',
    channel,
    userId,
    content,
    timestamp: new Date(),
  };
}

/**
 * Create a normalized message from Slack
 */
export function normalizeSlackMessage(
  messageId: string,
  channelId: string,
  userId: string,
  content: string,
  channel: Channel,
  attachments?: MessageAttachment[],
  explicitSessionId?: string,
): NormalizedMessage {
  return {
    id: messageId,
    sessionId: explicitSessionId ?? `slack:${channelId}`,
    channelType: 'slack',
    channel,
    userId,
    content,
    attachments,
    timestamp: new Date(),
  };
}

/**
 * Create a normalized message from WhatsApp
 */
export function normalizeWhatsAppMessage(
  messageId: string,
  chatId: string,
  userId: string,
  content: string,
  channel: Channel,
  attachments?: MessageAttachment[],
  explicitSessionId?: string,
): NormalizedMessage {
  return {
    id: messageId,
    sessionId: explicitSessionId ?? `whatsapp:${chatId}`,
    channelType: 'whatsapp',
    channel,
    userId,
    content,
    attachments,
    timestamp: new Date(),
  };
}

/**
 * Create a normalized message from Telegram
 */
export function normalizeTelegramMessage(
  messageId: string,
  chatId: string,
  userId: string,
  content: string,
  channel: Channel,
  attachments?: MessageAttachment[],
  explicitSessionId?: string,
): NormalizedMessage {
  return {
    id: messageId,
    sessionId: explicitSessionId ?? `telegram:${chatId}`,
    channelType: 'telegram',
    channel,
    userId,
    content,
    attachments,
    timestamp: new Date(),
  };
}

/**
 * Abstract channel implementation helper
 */
export abstract class BaseChannel implements Channel {
  abstract type: ChannelType;
  abstract send(content: string): Promise<void>;
  abstract sendStream(stream: AsyncIterable<string>): Promise<void>;
  abstract requestConfirmation(
    prompt: string,
    details?: import('../types.js').ConfirmationDetails
  ): Promise<import('../types.js').ConfirmationDecision>;
}
