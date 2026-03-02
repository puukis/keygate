import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  downloadMediaMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import {
  IMAGE_UPLOAD_ALLOWED_MIME_TYPES,
  IMAGE_UPLOAD_MAX_BYTES,
  getSessionUploadsDir,
  normalizeUploadMimeType,
  persistUploadedImage,
  sanitizeUploadAttachmentId,
  sanitizeUploadSessionId,
} from '../attachments/uploadStore.js';
import type { MessageAttachment } from '../types.js';

export const WHATSAPP_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

interface MediaDescriptor {
  kind: 'image' | 'audio' | 'document' | 'video';
  payload: Record<string, unknown>;
  contentType: string;
  filename?: string;
}

function sanitizeFilename(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }

  const normalized = value
    .trim()
    .replace(/[/\\?%*:|"<>]+/g, '-')
    .replace(/\s+/g, ' ');

  return normalized.length > 0 ? normalized : fallback;
}

function extensionForContentType(contentType: string): string {
  if (contentType === 'audio/ogg') {
    return '.ogg';
  }
  if (contentType.startsWith('audio/')) {
    return '.audio';
  }
  if (contentType === 'application/pdf') {
    return '.pdf';
  }
  if (contentType.startsWith('video/')) {
    return '.mp4';
  }

  return '.bin';
}

function unwrapWhatsAppMessageContent(content: unknown): Record<string, unknown> | null {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return null;
  }

  const record = content as Record<string, unknown>;
  if (record['ephemeralMessage']) {
    return unwrapWhatsAppMessageContent((record['ephemeralMessage'] as Record<string, unknown>)?.['message']);
  }
  if (record['viewOnceMessage']) {
    return unwrapWhatsAppMessageContent((record['viewOnceMessage'] as Record<string, unknown>)?.['message']);
  }
  if (record['documentWithCaptionMessage']) {
    return unwrapWhatsAppMessageContent((record['documentWithCaptionMessage'] as Record<string, unknown>)?.['message']);
  }

  return record;
}

function extractMediaDescriptor(content: unknown): MediaDescriptor | null {
  const message = unwrapWhatsAppMessageContent(content);
  if (!message) {
    return null;
  }

  const imageMessage = message['imageMessage'] as Record<string, unknown> | undefined;
  if (imageMessage) {
    return {
      kind: 'image',
      payload: imageMessage,
      contentType: normalizeUploadMimeType(String(imageMessage['mimetype'] ?? 'image/jpeg')) || 'image/jpeg',
      filename: typeof imageMessage['fileName'] === 'string' ? imageMessage['fileName'] : undefined,
    };
  }

  const audioMessage = message['audioMessage'] as Record<string, unknown> | undefined;
  if (audioMessage) {
    return {
      kind: 'audio',
      payload: audioMessage,
      contentType: normalizeUploadMimeType(String(audioMessage['mimetype'] ?? 'audio/ogg')) || 'audio/ogg',
      filename: typeof audioMessage['fileName'] === 'string' ? audioMessage['fileName'] : undefined,
    };
  }

  const documentMessage = message['documentMessage'] as Record<string, unknown> | undefined;
  if (documentMessage) {
    return {
      kind: 'document',
      payload: documentMessage,
      contentType: normalizeUploadMimeType(String(documentMessage['mimetype'] ?? 'application/octet-stream')) || 'application/octet-stream',
      filename: typeof documentMessage['fileName'] === 'string' ? documentMessage['fileName'] : undefined,
    };
  }

  const videoMessage = message['videoMessage'] as Record<string, unknown> | undefined;
  if (videoMessage) {
    return {
      kind: 'video',
      payload: videoMessage,
      contentType: normalizeUploadMimeType(String(videoMessage['mimetype'] ?? 'video/mp4')) || 'video/mp4',
      filename: typeof videoMessage['fileName'] === 'string' ? videoMessage['fileName'] : undefined,
    };
  }

  return null;
}

async function persistBinaryAttachment(
  workspacePath: string,
  sessionId: string,
  input: {
    bytes: Buffer;
    contentType: string;
    filename?: string;
    attachmentId?: string;
  }
): Promise<MessageAttachment> {
  const normalizedSessionId = sanitizeUploadSessionId(sessionId);
  if (!normalizedSessionId) {
    throw new Error('Valid sessionId is required.');
  }

  if (input.bytes.length === 0) {
    throw new Error('Attachment payload cannot be empty.');
  }

  const attachmentId = sanitizeUploadAttachmentId(input.attachmentId ?? null) ?? randomUUID();
  const sessionUploadsDir = getSessionUploadsDir(workspacePath, normalizedSessionId);
  const targetPath = path.resolve(path.join(sessionUploadsDir, `${attachmentId}${extensionForContentType(input.contentType)}`));

  await fs.mkdir(sessionUploadsDir, { recursive: true });
  await fs.writeFile(targetPath, input.bytes);

  return {
    id: attachmentId,
    filename: sanitizeFilename(input.filename, `upload-${attachmentId}${path.extname(targetPath)}`),
    contentType: input.contentType,
    sizeBytes: input.bytes.length,
    path: targetPath,
    url: `/api/uploads/image?sessionId=${encodeURIComponent(normalizedSessionId)}&id=${encodeURIComponent(attachmentId)}`,
  };
}

export async function ingestWhatsAppMediaAttachment(
  workspacePath: string,
  sessionId: string,
  sock: WASocket,
  message: { key?: unknown; message?: unknown }
): Promise<{ attachment?: MessageAttachment; rejectionReason?: string }> {
  const descriptor = extractMediaDescriptor(message.message);
  if (!descriptor) {
    return {};
  }

  const fileLength = Number.parseInt(String(descriptor.payload['fileLength'] ?? '0'), 10);
  if (Number.isFinite(fileLength) && fileLength > WHATSAPP_MEDIA_MAX_BYTES) {
    return {
      rejectionReason: `Attachment exceeds the ${WHATSAPP_MEDIA_MAX_BYTES} byte limit.`,
    };
  }

  if (descriptor.kind === 'image' && !IMAGE_UPLOAD_ALLOWED_MIME_TYPES.has(descriptor.contentType)) {
    return { rejectionReason: 'Only png, jpeg, webp, and gif images are supported.' };
  }

  const bytes = await downloadMediaMessage(
    message as Parameters<typeof downloadMediaMessage>[0],
    'buffer',
    {},
    { reuploadRequest: sock.updateMediaMessage }
  ) as Buffer;

  if (!Buffer.isBuffer(bytes)) {
    return { rejectionReason: 'Failed to download media attachment.' };
  }

  if (descriptor.kind === 'image') {
    if (bytes.length > IMAGE_UPLOAD_MAX_BYTES) {
      return { rejectionReason: `Attachment exceeds the ${IMAGE_UPLOAD_MAX_BYTES} byte image limit.` };
    }

    return {
      attachment: await persistUploadedImage(workspacePath, sessionId, {
        bytes,
        contentType: descriptor.contentType,
        filename: descriptor.filename,
      }),
    };
  }

  return {
    attachment: await persistBinaryAttachment(workspacePath, sessionId, {
      bytes,
      contentType: descriptor.contentType,
      filename: descriptor.filename,
    }),
  };
}
