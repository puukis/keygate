import { promises as fs } from 'node:fs';
import type { Message, MessageAttachment } from '../types.js';

export async function readAttachmentAsBase64(
  attachment: MessageAttachment
): Promise<{ base64: string; contentType: string } | null> {
  try {
    const bytes = await fs.readFile(attachment.path);
    return {
      base64: bytes.toString('base64'),
      contentType: attachment.contentType,
    };
  } catch {
    return null;
  }
}

export async function readAttachmentAsDataUrl(attachment: MessageAttachment): Promise<string | null> {
  const payload = await readAttachmentAsBase64(attachment);
  if (!payload) {
    return null;
  }

  return `data:${payload.contentType};base64,${payload.base64}`;
}

export function getLatestUserMessageAttachments(messages: Message[]): MessageAttachment[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') {
      continue;
    }

    if (!message.attachments || message.attachments.length === 0) {
      return [];
    }

    return message.attachments;
  }

  return [];
}
