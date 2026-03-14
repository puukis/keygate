import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import OpenAI from 'openai';
import type { KeygateConfig, MessageAttachment } from '../types.js';
import { getConfigDir } from '../config/env.js';
import { attachmentKindFromMimeType } from '../attachments/uploadStore.js';
import { readAttachmentAsDataUrl } from '../llm/attachments.js';

const execFileAsync = promisify(execFile);
const PREVIEW_TEXT_MAX_LENGTH = 6_000;

interface MediaCacheEntry {
  sha256: string;
  kind: MessageAttachment['kind'];
  previewText?: string;
  durationMs?: number;
  width?: number;
  height?: number;
  pageCount?: number;
  metadata?: Record<string, unknown>;
  updatedAt: string;
}

interface FfprobeStream {
  codec_type?: string;
  duration?: string;
  width?: number;
  height?: number;
}

interface FfprobeResult {
  streams?: FfprobeStream[];
  format?: {
    duration?: string;
  };
}

function buildDefaultMediaConfig(config: KeygateConfig): NonNullable<KeygateConfig['media']> {
  return config.media ?? {
    enabled: true,
    cacheDir: path.join(getConfigDir(), 'media-cache'),
    openai: {
      imageModel: 'gpt-4.1-mini',
      transcriptionModel: 'gpt-4o-mini-transcribe',
      ttsModel: 'gpt-4o-mini-tts',
      ttsVoice: 'alloy',
    },
    fallbacks: {
      ffmpegBinary: process.env['FFMPEG_PATH'] ?? 'ffmpeg',
      ffprobeBinary: process.env['FFPROBE_PATH'] ?? 'ffprobe',
      whisperBinary: process.env['WHISPER_PATH'] ?? 'whisper',
      whisperCliBinary: process.env['WHISPER_CLI_PATH'] ?? 'whisper',
    },
    maxAttachmentBytes: 25 * 1024 * 1024,
    maxPdfPages: 20,
    maxImageDescriptionTokens: 300,
  };
}

export class MediaUnderstandingService {
  private readonly mediaConfig: NonNullable<KeygateConfig['media']>;
  private readonly cacheFilePath: string;
  private cacheLoaded = false;
  private readonly cache = new Map<string, MediaCacheEntry>();

  constructor(private readonly config: KeygateConfig) {
    this.mediaConfig = buildDefaultMediaConfig(config);
    this.cacheFilePath = path.join(this.mediaConfig.cacheDir, 'artifacts.json');
  }

  isEnabled(): boolean {
    return this.mediaConfig.enabled;
  }

  async prepareAttachments(attachments: MessageAttachment[] | undefined): Promise<MessageAttachment[] | undefined> {
    if (!attachments || attachments.length === 0 || !this.mediaConfig.enabled) {
      return attachments;
    }

    return Promise.all(attachments.map(async (attachment) => this.prepareAttachment(attachment)));
  }

  buildPromptPrefix(attachments: MessageAttachment[] | undefined): string | null {
    if (!attachments || attachments.length === 0) {
      return null;
    }

    const lines = attachments.flatMap((attachment) => {
      const preview = typeof attachment.previewText === 'string' ? attachment.previewText.trim() : '';
      if (!preview) {
        return [];
      }
      const label = attachment.filename || attachment.id;
      const kind = attachment.kind ?? attachmentKindFromMimeType(attachment.contentType);
      return [`[Attachment ${kind ?? 'file'}: ${label}] ${preview}`];
    });

    return lines.length > 0 ? lines.join('\n') : null;
  }

  async describeAttachment(attachment: MessageAttachment): Promise<string | null> {
    const prepared = await this.prepareAttachment(attachment);
    return typeof prepared.previewText === 'string' && prepared.previewText.trim().length > 0
      ? prepared.previewText
      : null;
  }

  private async prepareAttachment(attachment: MessageAttachment): Promise<MessageAttachment> {
    await this.ensureCacheLoaded();

    const bytes = await fs.readFile(attachment.path);
    const sha256 = attachment.sha256 ?? createHash('sha256').update(bytes).digest('hex');
    const kind = attachment.kind ?? attachmentKindFromMimeType(attachment.contentType);

    const cached = this.cache.get(sha256);
    if (cached) {
      return this.mergeAttachment(attachment, cached, sha256, kind);
    }

    const measured = await this.measureAttachment(attachment, bytes, kind);
    const previewText = await this.derivePreviewText({
      ...attachment,
      sha256,
      kind,
      ...measured,
    });

    const entry: MediaCacheEntry = {
      sha256,
      kind,
      previewText: clipPreviewText(previewText),
      durationMs: measured.durationMs,
      width: measured.width,
      height: measured.height,
      pageCount: measured.pageCount,
      metadata: measured.metadata,
      updatedAt: new Date().toISOString(),
    };
    this.cache.set(sha256, entry);
    await this.persistCache();

    return this.mergeAttachment(attachment, entry, sha256, kind);
  }

  private mergeAttachment(
    attachment: MessageAttachment,
    entry: MediaCacheEntry,
    sha256: string,
    kind: MessageAttachment['kind']
  ): MessageAttachment {
    return {
      ...attachment,
      sha256,
      kind,
      previewText: entry.previewText,
      durationMs: entry.durationMs,
      width: entry.width,
      height: entry.height,
      pageCount: entry.pageCount,
      metadata: entry.metadata,
    };
  }

  private async measureAttachment(
    attachment: MessageAttachment,
    bytes: Buffer,
    kind: MessageAttachment['kind']
  ): Promise<Pick<MessageAttachment, 'durationMs' | 'width' | 'height' | 'pageCount' | 'metadata'>> {
    const base: Pick<MessageAttachment, 'durationMs' | 'width' | 'height' | 'pageCount' | 'metadata'> = {};

    if (kind === 'image') {
      const dimensions = await this.measureImage(attachment.path);
      if (dimensions) {
        base.width = dimensions.width;
        base.height = dimensions.height;
      }
      return base;
    }

    if (kind === 'pdf') {
      const pdf = await this.extractPdfText(attachment.path);
      if (pdf) {
        base.pageCount = pdf.pageCount;
        base.metadata = {
          textLength: pdf.text.length,
        };
      }
      return base;
    }

    if (kind === 'audio' || kind === 'video') {
      const probe = await this.ffprobe(attachment.path);
      if (probe) {
        const stream = probe.streams?.find((candidate) => candidate.codec_type === (kind === 'video' ? 'video' : 'audio'))
          ?? probe.streams?.[0];
        const durationSeconds = Number(stream?.duration ?? probe.format?.duration ?? 0);
        if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
          base.durationMs = Math.round(durationSeconds * 1000);
        }
        if (typeof stream?.width === 'number') {
          base.width = stream.width;
        }
        if (typeof stream?.height === 'number') {
          base.height = stream.height;
        }
      }
      return base;
    }

    base.metadata = { sizeBytes: bytes.length };
    return base;
  }

  private async derivePreviewText(attachment: MessageAttachment): Promise<string | undefined> {
    switch (attachment.kind) {
      case 'image':
        return this.describeImage(attachment);
      case 'audio':
        return this.transcribeAudio(attachment);
      case 'video':
        return this.describeVideo(attachment);
      case 'pdf':
        return this.describePdf(attachment);
      default:
        return undefined;
    }
  }

  private async describeImage(attachment: MessageAttachment): Promise<string | undefined> {
    const client = this.getOpenAiClient();
    const dataUrl = await readAttachmentAsDataUrl(attachment);
    if (client && dataUrl) {
      try {
        const response = await client.responses.create({
          model: this.mediaConfig.openai.imageModel,
          input: [{
            role: 'user',
            content: [
              { type: 'input_text', text: 'Describe this image for an AI assistant. Focus on visible text, objects, and actionable context.' },
              { type: 'input_image', image_url: dataUrl },
            ],
          }],
          max_output_tokens: this.mediaConfig.maxImageDescriptionTokens,
        } as never);
        const outputText = extractOpenAiOutputText(response);
        if (outputText) {
          return outputText;
        }
      } catch {
        // Fall through to local metadata-only fallback.
      }
    }

    const dimensions = (typeof attachment.width === 'number' && typeof attachment.height === 'number')
      ? `${attachment.width}x${attachment.height}`
      : 'unknown size';
    return `Image attachment (${dimensions}).`;
  }

  private async transcribeAudio(attachment: MessageAttachment): Promise<string | undefined> {
    const client = this.getOpenAiClient();
    if (client) {
      try {
        const stream = fsSync.createReadStream(attachment.path);
        const result = await client.audio.transcriptions.create({
          file: stream,
          model: this.mediaConfig.openai.transcriptionModel,
        } as never);
        const text = typeof result === 'object' && result && 'text' in result
          ? String((result as { text?: unknown }).text ?? '').trim()
          : '';
        if (text) {
          return text;
        }
      } catch {
        // Fall through to whisper fallback.
      }
    }

    const whisperText = await this.transcribeWithWhisperCli(attachment.path);
    if (whisperText) {
      return whisperText;
    }

    return 'Audio attachment uploaded.';
  }

  private async describeVideo(attachment: MessageAttachment): Promise<string | undefined> {
    const framePath = await this.extractVideoFrame(attachment.path);
    if (framePath) {
      try {
        const preview = await this.describeImage({
          ...attachment,
          contentType: 'image/png',
          kind: 'image',
          path: framePath,
        });
        if (preview) {
          return preview;
        }
      } finally {
        await fs.unlink(framePath).catch(() => {});
      }
    }

    const durationLabel = typeof attachment.durationMs === 'number'
      ? `, ${Math.round(attachment.durationMs / 1000)}s`
      : '';
    return `Video attachment${durationLabel}.`;
  }

  private async describePdf(attachment: MessageAttachment): Promise<string | undefined> {
    const extracted = await this.extractPdfText(attachment.path);
    if (!extracted || extracted.text.trim().length === 0) {
      return 'PDF attachment uploaded.';
    }

    const compact = extracted.text.replace(/\s+/g, ' ').trim();
    const pages = extracted.pageCount > 0 ? ` (${extracted.pageCount} pages)` : '';
    return `${compact.slice(0, PREVIEW_TEXT_MAX_LENGTH)}${pages}`;
  }

  private async measureImage(filePath: string): Promise<{ width: number; height: number } | null> {
    try {
      const { loadImage } = await import('@napi-rs/canvas');
      const image = await loadImage(filePath);
      return {
        width: image.width,
        height: image.height,
      };
    } catch {
      return null;
    }
  }

  private async extractPdfText(filePath: string): Promise<{ text: string; pageCount: number } | null> {
    try {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const bytes = await fs.readFile(filePath);
      const document = await pdfjs.getDocument({
        data: new Uint8Array(bytes),
        useWorkerFetch: false,
        isEvalSupported: false,
      }).promise;
      const texts: string[] = [];
      const pageCount = Math.min(document.numPages, this.mediaConfig.maxPdfPages);
      for (let index = 1; index <= pageCount; index += 1) {
        const page = await document.getPage(index);
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => ('str' in item ? item.str : ''))
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .join(' ');
        if (pageText) {
          texts.push(pageText);
        }
      }
      return {
        text: texts.join('\n\n'),
        pageCount,
      };
    } catch {
      return null;
    }
  }

  private async ffprobe(filePath: string): Promise<FfprobeResult | null> {
    try {
      const result = await execFileAsync(this.mediaConfig.fallbacks.ffprobeBinary ?? 'ffprobe', [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_streams',
        '-show_format',
        filePath,
      ]);
      return JSON.parse(result.stdout) as FfprobeResult;
    } catch {
      return null;
    }
  }

  private async extractVideoFrame(filePath: string): Promise<string | null> {
    const targetPath = path.join(
      this.mediaConfig.cacheDir,
      `${path.basename(filePath, path.extname(filePath))}-${Date.now()}.png`
    );
    try {
      await fs.mkdir(this.mediaConfig.cacheDir, { recursive: true });
      await execFileAsync(this.mediaConfig.fallbacks.ffmpegBinary ?? 'ffmpeg', [
        '-y',
        '-i',
        filePath,
        '-vf',
        'thumbnail,scale=960:-1',
        '-frames:v',
        '1',
        targetPath,
      ]);
      return targetPath;
    } catch {
      return null;
    }
  }

  private async transcribeWithWhisperCli(filePath: string): Promise<string | undefined> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-whisper-'));
    try {
      await execFileAsync(this.mediaConfig.fallbacks.whisperCliBinary ?? this.mediaConfig.fallbacks.whisperBinary ?? 'whisper', [
        filePath,
        '--output_format',
        'txt',
        '--output_dir',
        tempDir,
      ]);
      const textPath = path.join(tempDir, `${path.basename(filePath, path.extname(filePath))}.txt`);
      const text = await fs.readFile(textPath, 'utf8').catch(() => '');
      return text.trim() || undefined;
    } catch {
      return undefined;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private getOpenAiClient(): OpenAI | null {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) {
      return null;
    }

    return new OpenAI({ apiKey });
  }

  private async ensureCacheLoaded(): Promise<void> {
    if (this.cacheLoaded) {
      return;
    }

    this.cacheLoaded = true;
    await fs.mkdir(this.mediaConfig.cacheDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.cacheFilePath, 'utf8');
      const parsed = JSON.parse(raw) as MediaCacheEntry[];
      for (const entry of parsed) {
        if (entry && typeof entry.sha256 === 'string') {
          this.cache.set(entry.sha256, entry);
        }
      }
    } catch {
      // Cache file is optional.
    }
  }

  private async persistCache(): Promise<void> {
    await fs.mkdir(this.mediaConfig.cacheDir, { recursive: true });
    await fs.writeFile(
      this.cacheFilePath,
      JSON.stringify(Array.from(this.cache.values()), null, 2),
      'utf8'
    );
  }
}

function extractOpenAiOutputText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const outputText = (value as { output_text?: unknown }).output_text;
  if (typeof outputText === 'string' && outputText.trim().length > 0) {
    return outputText.trim();
  }

  return undefined;
}

function clipPreviewText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > PREVIEW_TEXT_MAX_LENGTH
    ? `${normalized.slice(0, PREVIEW_TEXT_MAX_LENGTH)}...`
    : normalized;
}
