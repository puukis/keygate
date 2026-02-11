import type { Channel, ChannelType, MessageAttachment, NormalizedMessage } from '../types.js';
import { randomUUID } from 'node:crypto';

/**
 * Create a normalized message from Discord
 */
export function normalizeDiscordMessage(
  messageId: string,
  channelId: string,
  userId: string,
  content: string,
  channel: Channel
): NormalizedMessage {
  return {
    id: messageId,
    sessionId: `discord:${channelId}`,
    channelType: 'discord',
    channel,
    userId,
    content,
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
