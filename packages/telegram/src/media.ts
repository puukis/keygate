import type { Context } from 'grammy';
import {
  IMAGE_UPLOAD_ALLOWED_MIME_TYPES,
  IMAGE_UPLOAD_MAX_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
  normalizeUploadMimeType,
  persistUploadedImage,
  type MessageAttachment,
} from '@puukis/core';

interface TelegramFileCandidate {
  fileId: string;
  mimeType?: string;
  filename?: string;
}

/**
 * Extract and download inbound media attachments from a Telegram message.
 * Supports: photo, document, voice, video, sticker.
 */
export async function ingestTelegramMediaAttachments(
  workspacePath: string,
  sessionId: string,
  ctx: Context,
  botToken: string,
): Promise<MessageAttachment[]> {
  const msg = ctx.message;
  if (!msg) return [];

  const candidates = resolveFileCandidates(msg);
  if (candidates.length === 0) return [];

  const attachments: MessageAttachment[] = [];

  for (const candidate of candidates.slice(0, MAX_MESSAGE_ATTACHMENTS)) {
    try {
      const contentType = normalizeUploadMimeType(candidate.mimeType ?? guessMimeFromFileId(candidate.fileId));

      if (!IMAGE_UPLOAD_ALLOWED_MIME_TYPES.has(contentType)) {
        if (contentType) {
          console.info(`Ignoring Telegram attachment with unsupported type ${contentType} in ${sessionId}.`);
        }
        continue;
      }

      // Get download URL from Telegram
      const fileInfoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(candidate.fileId)}`;
      const fileInfoRes = await fetch(fileInfoUrl);
      if (!fileInfoRes.ok) {
        console.warn(`Failed to get Telegram file info in ${sessionId}: HTTP ${fileInfoRes.status}.`);
        continue;
      }

      const fileInfo = await fileInfoRes.json() as { ok: boolean; result?: { file_path?: string } };
      const filePath = fileInfo.result?.file_path;
      if (!filePath) {
        console.warn(`No file_path for Telegram attachment in ${sessionId}.`);
        continue;
      }

      const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
      const downloadRes = await fetch(downloadUrl);
      if (!downloadRes.ok) {
        console.warn(`Failed to download Telegram attachment in ${sessionId}: HTTP ${downloadRes.status}.`);
        continue;
      }

      const bytes = Buffer.from(await downloadRes.arrayBuffer());
      if (bytes.length > IMAGE_UPLOAD_MAX_BYTES) {
        console.warn(`Ignoring oversized Telegram attachment (${bytes.length} bytes) in ${sessionId}.`);
        continue;
      }

      const persisted = await persistUploadedImage(workspacePath, sessionId, {
        bytes,
        contentType,
        filename: candidate.filename ?? undefined,
      });
      attachments.push(persisted);
    } catch (error) {
      console.warn(`Failed to ingest Telegram attachment in ${sessionId}:`, error);
    }
  }

  return attachments;
}

function resolveFileCandidates(msg: NonNullable<Context['message']>): TelegramFileCandidate[] {
  const candidates: TelegramFileCandidate[] = [];

  // Photo: array of sizes — use the largest
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]!;
    candidates.push({ fileId: largest.file_id, mimeType: 'image/jpeg', filename: 'photo.jpg' });
  }

  // Document (any file type)
  if (msg.document) {
    candidates.push({
      fileId: msg.document.file_id,
      mimeType: msg.document.mime_type ?? undefined,
      filename: msg.document.file_name ?? undefined,
    });
  }

  // Voice message (ogg/opus)
  if (msg.voice) {
    candidates.push({
      fileId: msg.voice.file_id,
      mimeType: msg.voice.mime_type ?? 'audio/ogg',
      filename: 'voice.ogg',
    });
  }

  // Video
  if (msg.video) {
    candidates.push({
      fileId: msg.video.file_id,
      mimeType: msg.video.mime_type ?? 'video/mp4',
      filename: 'video.mp4',
    });
  }

  // Sticker (webp)
  if (msg.sticker) {
    candidates.push({
      fileId: msg.sticker.file_id,
      mimeType: 'image/webp',
      filename: 'sticker.webp',
    });
  }

  return candidates;
}

function guessMimeFromFileId(fileId: string): string {
  // Telegram file IDs encode the type in the prefix characters; this is a rough heuristic
  if (fileId.startsWith('AgA')) return 'image/jpeg';
  if (fileId.startsWith('BQA')) return 'application/octet-stream';
  return '';
}
