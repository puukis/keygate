import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { MessageAttachment } from '../types.js';

export const ATTACHMENT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const IMAGE_UPLOAD_MAX_BYTES = ATTACHMENT_UPLOAD_MAX_BYTES;
export const MAX_MESSAGE_ATTACHMENTS = 5;
export const ATTACHMENT_UPLOAD_ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/pdf',
]);
export const IMAGE_UPLOAD_ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const ATTACHMENT_UPLOAD_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.mp3',
  '.wav',
  '.ogg',
  '.webm',
  '.m4a',
  '.mp4',
  '.mov',
  '.pdf',
];

export interface UploadAttachmentRef {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  url: string;
}

export interface PersistUploadedAttachmentInput {
  bytes: Buffer;
  contentType: string;
  filename?: string;
  attachmentId?: string;
}

export type PersistUploadedImageInput = PersistUploadedAttachmentInput;

export function getUploadsRoot(workspacePath: string): string {
  return path.resolve(path.join(workspacePath, '.keygate-uploads'));
}

export function getSessionUploadsDir(workspacePath: string, sessionId: string): string {
  return path.resolve(path.join(getUploadsRoot(workspacePath), mapSessionIdToUploadDir(sessionId)));
}

export function getLegacySessionUploadsDir(workspacePath: string, sessionId: string): string {
  return path.resolve(path.join(getUploadsRoot(workspacePath), sessionId));
}

export function getSessionUploadRoots(workspacePath: string, sessionId: string): string[] {
  const mapped = getSessionUploadsDir(workspacePath, sessionId);
  const legacy = getLegacySessionUploadsDir(workspacePath, sessionId);
  return mapped === legacy ? [mapped] : [mapped, legacy];
}

export function mapSessionIdToUploadDir(sessionId: string): string {
  const base = sessionId
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
  return `${base || 'session'}-${hash}`;
}

export function normalizeUploadMimeType(value: string | undefined): string {
  if (!value) {
    return '';
  }

  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export function attachmentKindFromMimeType(contentType: string): MessageAttachment['kind'] {
  if (contentType.startsWith('image/')) {
    return 'image';
  }
  if (contentType.startsWith('audio/')) {
    return 'audio';
  }
  if (contentType.startsWith('video/')) {
    return 'video';
  }
  if (contentType === 'application/pdf') {
    return 'pdf';
  }
  return 'document';
}

export function extensionForMimeType(contentType: string): string {
  switch (contentType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'audio/mpeg':
    case 'audio/mp3':
      return '.mp3';
    case 'audio/wav':
    case 'audio/x-wav':
      return '.wav';
    case 'audio/ogg':
      return '.ogg';
    case 'audio/webm':
      return '.webm';
    case 'audio/mp4':
      return '.m4a';
    case 'video/mp4':
      return '.mp4';
    case 'video/webm':
      return '.webm';
    case 'video/quicktime':
      return '.mov';
    case 'application/pdf':
      return '.pdf';
    default:
      return '.bin';
  }
}

export const imageExtensionForMimeType = extensionForMimeType;

export function getUploadContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.ogg':
      return 'audio/ogg';
    case '.m4a':
      return 'audio/mp4';
    case '.mp4':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

export function isUploadPathWithinRoot(rootDir: string, targetPath: string): boolean {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);

  if (resolvedTarget === resolvedRoot) {
    return true;
  }

  return resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

export function sanitizeUploadSessionId(value: string | null): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (!/^[A-Za-z0-9:_-]+$/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

export function sanitizeUploadAttachmentId(value: string | null): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

export function buildUploadedImageUrl(sessionId: string, attachmentId: string): string {
  return buildUploadedAttachmentUrl(sessionId, attachmentId, 'image');
}

export function buildUploadedAttachmentUrl(
  sessionId: string,
  attachmentId: string,
  kind: MessageAttachment['kind'] = 'document'
): string {
  const sessionParam = encodeURIComponent(sessionId);
  const idParam = encodeURIComponent(attachmentId);
  const route = kind === 'image' ? 'image' : 'attachment';
  return `/api/uploads/${route}?sessionId=${sessionParam}&id=${idParam}`;
}

export async function persistUploadedAttachment(
  workspacePath: string,
  sessionId: string,
  input: PersistUploadedAttachmentInput
): Promise<MessageAttachment> {
  const normalizedSessionId = sanitizeUploadSessionId(sessionId);
  if (!normalizedSessionId) {
    throw new Error('Valid sessionId is required.');
  }

  const contentType = normalizeUploadMimeType(input.contentType);
  if (!ATTACHMENT_UPLOAD_ALLOWED_MIME_TYPES.has(contentType)) {
    throw new Error('Only image, audio, video, and PDF uploads are supported.');
  }

  const bytes = input.bytes;
  if (bytes.length === 0) {
    throw new Error('Attachment payload cannot be empty.');
  }
  if (bytes.length > ATTACHMENT_UPLOAD_MAX_BYTES) {
    throw new Error(`Attachment exceeds ${ATTACHMENT_UPLOAD_MAX_BYTES} bytes.`);
  }

  const attachmentId = sanitizeUploadAttachmentId(input.attachmentId ?? null) ?? randomUUID();
  const extension = extensionForMimeType(contentType);
  const sessionUploadsDir = getSessionUploadsDir(workspacePath, normalizedSessionId);
  const targetPath = path.resolve(path.join(sessionUploadsDir, `${attachmentId}${extension}`));

  if (!isUploadPathWithinRoot(sessionUploadsDir, targetPath)) {
    throw new Error('Invalid upload path.');
  }

  await fs.mkdir(sessionUploadsDir, { recursive: true });
  await fs.writeFile(targetPath, bytes);

  const fallbackName = `upload-${attachmentId}${extension}`;
  const normalizedFilename = sanitizeUploadFilename(input.filename, fallbackName);
  const kind = attachmentKindFromMimeType(contentType);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  return {
    id: attachmentId,
    filename: normalizedFilename,
    contentType,
    sizeBytes: bytes.length,
    path: targetPath,
    kind,
    sha256,
    url: buildUploadedAttachmentUrl(normalizedSessionId, attachmentId, kind),
  };
}

export async function persistUploadedImage(
  workspacePath: string,
  sessionId: string,
  input: PersistUploadedImageInput
): Promise<MessageAttachment> {
  return persistUploadedAttachment(workspacePath, sessionId, input);
}

export async function resolveUploadPathByAttachmentId(
  workspacePath: string,
  sessionId: string,
  attachmentId: string
): Promise<string | null> {
  const sessionRoots = getSessionUploadRoots(workspacePath, sessionId);

  for (const sessionRoot of sessionRoots) {
    for (const extension of ATTACHMENT_UPLOAD_EXTENSIONS) {
      const candidate = path.resolve(path.join(sessionRoot, `${attachmentId}${extension}`));
      if (!isUploadPathWithinRoot(sessionRoot, candidate)) {
        continue;
      }

      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) {
          return candidate;
        }
      } catch {
        // Try next extension.
      }
    }
  }

  return null;
}

export async function resolveMessageAttachmentRefs(
  workspacePath: string,
  sessionId: string,
  refs: UploadAttachmentRef[] | undefined
): Promise<MessageAttachment[]> {
  if (!refs) {
    return [];
  }

  if (refs.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new Error(`A maximum of ${MAX_MESSAGE_ATTACHMENTS} attachments are allowed per message.`);
  }

  const seen = new Set<string>();
  const attachments: MessageAttachment[] = [];

  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') {
      throw new Error('Attachment payload is invalid.');
    }

    const attachmentId = sanitizeUploadAttachmentId(ref.id);
    if (!attachmentId) {
      throw new Error('Attachment id is invalid.');
    }

    if (seen.has(attachmentId)) {
      continue;
    }
    seen.add(attachmentId);

    const imagePath = await resolveUploadPathByAttachmentId(workspacePath, sessionId, attachmentId);
    if (!imagePath) {
      throw new Error(`Attachment ${attachmentId} no longer exists. Please upload it again.`);
    }

    const stat = await fs.stat(imagePath);
    if (!stat.isFile()) {
      throw new Error(`Attachment ${attachmentId} is invalid.`);
    }
    if (stat.size > ATTACHMENT_UPLOAD_MAX_BYTES) {
      throw new Error(`Attachment ${attachmentId} exceeds the ${ATTACHMENT_UPLOAD_MAX_BYTES} byte limit.`);
    }

    const contentType = normalizeUploadMimeType(getUploadContentType(imagePath));
    if (!ATTACHMENT_UPLOAD_ALLOWED_MIME_TYPES.has(contentType)) {
      throw new Error(`Attachment ${attachmentId} has an unsupported content type.`);
    }

    const filename = sanitizeUploadFilename(ref.filename, path.basename(imagePath));
    const bytes = await fs.readFile(imagePath);
    const kind = attachmentKindFromMimeType(contentType);

    attachments.push({
      id: attachmentId,
      filename,
      contentType,
      sizeBytes: stat.size,
      path: imagePath,
      kind,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      url: buildUploadedAttachmentUrl(sessionId, attachmentId, kind),
    });
  }

  return attachments;
}

export function isUploadPathAllowedForSession(
  workspacePath: string,
  sessionId: string,
  candidatePath: string
): boolean {
  const sessionRoots = getSessionUploadRoots(workspacePath, sessionId);
  return sessionRoots.some((rootDir) => isUploadPathWithinRoot(rootDir, candidatePath));
}

export async function cleanupExpiredUploadedImages(workspacePath: string, retentionMs: number): Promise<void> {
  const uploadsRoot = getUploadsRoot(workspacePath);
  const expiryCutoff = Date.now() - retentionMs;
  await cleanupUploadDirectory(uploadsRoot, uploadsRoot, expiryCutoff);
}

async function cleanupUploadDirectory(rootDir: string, currentDir: string, cutoffTimeMs: number): Promise<void> {
  let entries: import('node:fs').Dirent[] = [];

  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const resolvedPath = path.resolve(path.join(currentDir, entry.name));
    if (!isUploadPathWithinRoot(rootDir, resolvedPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      await cleanupUploadDirectory(rootDir, resolvedPath, cutoffTimeMs);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    try {
      const stat = await fs.stat(resolvedPath);
      if (stat.mtimeMs < cutoffTimeMs) {
        await fs.unlink(resolvedPath);
      }
    } catch {
      // Ignore files that disappear during cleanup.
    }
  }

  if (currentDir !== rootDir) {
    try {
      const remaining = await fs.readdir(currentDir);
      if (remaining.length === 0) {
        await fs.rmdir(currentDir);
      }
    } catch {
      // Ignore cleanup races.
    }
  }
}

function sanitizeUploadFilename(value: string | undefined, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const basename = path.basename(value.trim());
  if (!basename) {
    return fallback;
  }

  const cleaned = basename.replace(/[^\w.\-() ]+/g, '_');
  return cleaned.length > 0 ? cleaned : fallback;
}
