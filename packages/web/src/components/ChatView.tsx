import { useState, useRef, useEffect, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message, StreamActivity } from '../App';
import { buildScreenshotImageUrl, extractScreenshotFilenamesFromText } from '../browserPreview';
import { parseMessageSegments } from './messageContent';
import './ChatView.css';

interface ChatViewProps {
  messages: Message[];
  onSendMessage: (content: string, attachments?: Message['attachments']) => void;
  isStreaming: boolean;
  streamActivities: StreamActivity[];
  disabled: boolean;
  inputPlaceholder: string;
  sessionIdForUploads?: string | null;
  readOnlyHint?: string;
}

interface MessageRowProps {
  msg: Message;
  assistantAvatar: string;
  copiedCodeBlockId: string | null;
  onCopyCode: (blockId: string, code: string) => Promise<void> | void;
}

interface PendingAttachment {
  id: string;
  dedupeKey: string;
  file: File;
  previewUrl: string;
}

type UploadedAttachment = NonNullable<Message['attachments']>[number];

interface AttachmentFileLike {
  name: string;
  size: number;
  lastModified: number;
  type: string;
}

export interface PendingComposerAttachment<TFile extends AttachmentFileLike = AttachmentFileLike> {
  id: string;
  dedupeKey: string;
  file: TFile;
  previewUrl: string;
}

const STARTER_PROMPTS = [
  'Summarize the latest project changes and open tasks.',
  'Check the repo for security risks and suggest quick fixes.',
  'Write a deployment checklist for today\'s release.',
  'Draft a concise standup update from current progress.',
];

const AUTO_SCROLL_THRESHOLD_PX = 80;
const MAX_ATTACHMENT_COUNT = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_ASSISTANT_AVATAR = 'K';
const SUPPORTED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
const EMOJI_MATCHER = /(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)|(?:[\u{1F1E6}-\u{1F1FF}]{2})/u;
const EMOJI_MATCHER_GLOBAL = /(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)|(?:[\u{1F1E6}-\u{1F1FF}]{2})/gu;
const SIGNATURE_EMOJI_LINE_REGEX = /signature\s*emoji(?:\s*[:=-]|\s+is)?\s*(.+)$/i;
const EMOJI_SHORTCODE_REGEX = /^:[a-z0-9_+-]+:/i;
const AVATAR_DECORATION_REGEX = /[\s"'`~!@#$%^&*(){}[\]|\\/<>.,?;:_+=-]/g;

export const CHAT_MARKDOWN_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer noopener" />
  ),
  img: ({ node: _node, ...props }) => {
    const source = typeof props.src === 'string' ? props.src : '';
    if (!source) {
      return null;
    }

    return (
      <a href={source} target="_blank" rel="noreferrer noopener">
        <img
          {...props}
          src={source}
          alt={props.alt ?? 'Assistant image'}
          loading="lazy"
          className="message-markdown-image"
        />
      </a>
    );
  },
};

export function validateComposerAttachmentFile(
  file: Pick<AttachmentFileLike, 'type' | 'size'>
): string | null {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
    return 'Only PNG, JPEG, WEBP, and GIF images are supported.';
  }

  if (file.size > MAX_ATTACHMENT_BYTES) {
    return 'Each image must be 10MB or smaller.';
  }

  return null;
}

export function buildNextPendingAttachments<TFile extends AttachmentFileLike>(
  previous: PendingComposerAttachment<TFile>[],
  files: TFile[],
  options: {
    createId: () => string;
    createPreviewUrl: (file: TFile) => string;
  }
): {
  next: PendingComposerAttachment<TFile>[];
  error: string | null;
} {
  const next = [...previous];
  const seen = new Set(previous.map((attachment) => attachment.dedupeKey));
  let error: string | null = null;

  for (const file of files) {
    if (next.length >= MAX_ATTACHMENT_COUNT) {
      error = `You can attach up to ${MAX_ATTACHMENT_COUNT} images per message.`;
      break;
    }

    const validationError = validateComposerAttachmentFile(file);
    if (validationError) {
      error = validationError;
      continue;
    }

    const dedupeKey = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    next.push({
      id: options.createId(),
      dedupeKey,
      file,
      previewUrl: options.createPreviewUrl(file),
    });
  }

  return { next, error };
}

export function removePendingComposerAttachment<TFile extends AttachmentFileLike>(
  previous: PendingComposerAttachment<TFile>[],
  id: string
): {
  next: PendingComposerAttachment<TFile>[];
  removed: PendingComposerAttachment<TFile> | null;
} {
  const removed = previous.find((attachment) => attachment.id === id) ?? null;
  const next = removed
    ? previous.filter((attachment) => attachment.id !== id)
    : previous;

  return { next, removed };
}

function extractFirstEmoji(value: string): string | null {
  const match = value.match(EMOJI_MATCHER);
  return match?.[0] ?? null;
}

function parseSignatureEmojiToken(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const emoji = extractFirstEmoji(trimmed);
  if (emoji) {
    return emoji;
  }

  const shortcode = trimmed.match(EMOJI_SHORTCODE_REGEX);
  return shortcode?.[0] ?? null;
}

function extractExplicitSignatureEmoji(content: string): string | null {
  const lines = content.split(/\r?\n/g);
  for (const line of lines) {
    const match = line.match(SIGNATURE_EMOJI_LINE_REGEX);
    if (!match) {
      continue;
    }

    const parsed = parseSignatureEmojiToken(match[1] ?? '');
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function extractStandaloneSignatureEmoji(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > 16) {
    return null;
  }

  const emoji = extractFirstEmoji(trimmed);
  if (!emoji) {
    return null;
  }

  const stripped = trimmed
    .replace(EMOJI_MATCHER_GLOBAL, '')
    .replace(AVATAR_DECORATION_REGEX, '');
  return stripped.length === 0 ? emoji : null;
}

export function deriveAssistantAvatar(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'user') {
      continue;
    }

    const explicitSignature = extractExplicitSignatureEmoji(message.content);
    if (explicitSignature) {
      return explicitSignature;
    }

    const standaloneSignature = extractStandaloneSignatureEmoji(message.content);
    if (standaloneSignature) {
      return standaloneSignature;
    }
  }

  return DEFAULT_ASSISTANT_AVATAR;
}

function isNearBottom(container: HTMLDivElement): boolean {
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  return distanceFromBottom <= AUTO_SCROLL_THRESHOLD_PX;
}

export function ChatView({
  messages,
  onSendMessage,
  isStreaming,
  streamActivities,
  disabled,
  inputPlaceholder,
  sessionIdForUploads,
  readOnlyHint,
}: ChatViewProps) {
  const [input, setInput] = useState('');
  const [copiedCodeBlockId, setCopiedCodeBlockId] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const copyResetTimeoutRef = useRef<number | null>(null);
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);

  const hasStreamingMessage = messages.some((msg) => msg.id === 'streaming');
  const visibleActivities = streamActivities.slice(-4).reverse();
  const currentActivity = visibleActivities[0];
  const assistantAvatar = useMemo(() => deriveAssistantAvatar(messages), [messages]);

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current);
      }

      for (const attachment of pendingAttachmentsRef.current) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    };
  }, []);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || !shouldAutoScrollRef.current) {
      return;
    }

    container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
  }, [messages, isStreaming]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) {
      return;
    }

    const handleScroll = () => {
      shouldAutoScrollRef.current = isNearBottom(container);
    };

    handleScroll();
    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, []);

  const clearPendingAttachments = () => {
    for (const attachment of pendingAttachmentsRef.current) {
      URL.revokeObjectURL(attachment.previewUrl);
    }

    pendingAttachmentsRef.current = [];
    setPendingAttachments([]);
  };

  const addFiles = (files: File[]) => {
    if (files.length === 0) {
      return;
    }

    const result = buildNextPendingAttachments(pendingAttachmentsRef.current, files, {
      createId: () => crypto.randomUUID(),
      createPreviewUrl: (file) => URL.createObjectURL(file),
    });

    pendingAttachmentsRef.current = result.next;
    setPendingAttachments(result.next);
    setComposerError(result.error);
  };

  const removePendingAttachment = (id: string) => {
    const { next, removed } = removePendingComposerAttachment(pendingAttachmentsRef.current, id);
    if (removed) {
      URL.revokeObjectURL(removed.previewUrl);
    }

    pendingAttachmentsRef.current = next;
    setPendingAttachments(next);
  };

  const handleFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    addFiles(files);
    event.target.value = '';
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragActive(false);
    if (disabled || isStreaming || isUploading) {
      return;
    }

    const files = Array.from(event.dataTransfer.files ?? []);
    addFiles(files);
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled || isStreaming || isUploading) {
      return;
    }

    const files = Array.from(event.clipboardData.items ?? [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    addFiles(files);
  };

  const handleSubmit = async (event?: React.FormEvent) => {
    event?.preventDefault();

    const content = input.trim();
    const hasAttachments = pendingAttachments.length > 0;
    if ((!content && !hasAttachments) || disabled || isStreaming || isUploading) {
      return;
    }

    if (hasAttachments && !sessionIdForUploads) {
      setComposerError('Upload session is unavailable. Reconnect and try again.');
      return;
    }

    setComposerError(null);

    let uploadedAttachments: UploadedAttachment[] | undefined;

    if (hasAttachments) {
      setIsUploading(true);

      try {
        const results: UploadedAttachment[] = [];

        for (const attachment of pendingAttachments) {
          const response = await fetch(`/api/uploads/image?sessionId=${encodeURIComponent(sessionIdForUploads!)}`, {
            method: 'POST',
            headers: {
              'Content-Type': attachment.file.type,
            },
            body: attachment.file,
          });

          if (!response.ok) {
            const reason = await extractUploadError(response);
            throw new Error(reason);
          }

          const payload = await response.json() as unknown;
          const parsed = parseUploadedAttachment(payload);
          if (!parsed) {
            throw new Error('Image upload response was malformed.');
          }

          results.push(parsed);
        }

        uploadedAttachments = results;
      } catch (error) {
        setComposerError(error instanceof Error ? error.message : 'Image upload failed.');
        setIsUploading(false);
        return;
      }
    }

    onSendMessage(content, uploadedAttachments);
    setInput('');
    clearPendingAttachments();
    setIsUploading(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSubmit();
    }
  };

  const handleStarterPrompt = (prompt: string) => {
    if (disabled || isStreaming || isUploading) {
      return;
    }

    setInput(prompt);
    inputRef.current?.focus();
  };

  const handleCopyCode = async (blockId: string, code: string) => {
    const copied = await copyTextToClipboard(code);
    if (!copied) {
      return;
    }

    setCopiedCodeBlockId(blockId);
    if (copyResetTimeoutRef.current !== null) {
      window.clearTimeout(copyResetTimeoutRef.current);
    }

    copyResetTimeoutRef.current = window.setTimeout(() => {
      setCopiedCodeBlockId(null);
      copyResetTimeoutRef.current = null;
    }, 1500);
  };

  const isSubmitDisabled =
    (!input.trim() && pendingAttachments.length === 0)
    || disabled
    || isStreaming
    || isUploading;

  return (
    <div className="chat-view">
      {readOnlyHint && (
        <div className="chat-readonly-banner">
          {readOnlyHint}
        </div>
      )}
      <div className="messages-container" ref={messagesContainerRef}>
        {messages.length === 0 ? (
          <div className="empty-state animate-slide-in">
            <p className="empty-kicker">Ready</p>
            <h2>Talk to your AI workspace</h2>
            <p className="empty-copy">
              Use natural language to run tools, inspect files, and coordinate work in one place.
            </p>
            <div className="starter-grid">
              {STARTER_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="starter-chip"
                  onClick={() => handleStarterPrompt(prompt)}
                  disabled={disabled || isStreaming || isUploading}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg) => (
              <MessageRow
                key={msg.id}
                msg={msg}
                assistantAvatar={assistantAvatar}
                copiedCodeBlockId={copiedCodeBlockId}
                onCopyCode={handleCopyCode}
              />
            ))}

            {isStreaming && !hasStreamingMessage && (
              <div className="message assistant animate-slide-in thinking-message">
                <div className="message-avatar" aria-hidden="true">{assistantAvatar}</div>
                <div className="message-content">
                  <div className="message-header">
                    <span className="message-role">Keygate</span>
                    <span className="thinking-badge">
                      {currentActivity ? 'Live' : 'Thinking'}
                    </span>
                  </div>
                  <div className="message-bubble thinking-bubble">
                    <div className="thinking-status">
                      {currentActivity?.status ?? 'Working on your request'}
                      {!currentActivity && (
                        <span className="thinking-dots" aria-hidden="true">
                          <span>.</span>
                          <span>.</span>
                          <span>.</span>
                        </span>
                      )}
                    </div>
                    {currentActivity?.detail && (
                      <div className="thinking-detail">{currentActivity.detail}</div>
                    )}
                    {visibleActivities.length > 1 && (
                      <div className="thinking-activity-list">
                        {visibleActivities.slice(1).map((activity) => (
                          <div key={activity.id} className="thinking-activity-item">
                            <span className="thinking-activity-time">
                              {activity.timestamp.toLocaleTimeString()}
                            </span>
                            <span>{activity.status}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <form
        className={`input-container ${dragActive ? 'drag-active' : ''}`}
        onSubmit={(event) => void handleSubmit(event)}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled && !isStreaming && !isUploading) {
            setDragActive(true);
          }
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
      >
        <div className="composer-field">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={inputPlaceholder}
            disabled={disabled || isStreaming || isUploading}
            rows={1}
          />
          <div className="composer-actions-row">
            <button
              type="button"
              className="attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || isStreaming || isUploading || pendingAttachments.length >= MAX_ATTACHMENT_COUNT}
            >
              Add image
            </button>
            <p className="composer-tip">Press Enter to send, Shift+Enter for a new line.</p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="composer-file-input"
            onChange={handleFileInputChange}
          />

          {pendingAttachments.length > 0 && (
            <div className="pending-attachments-grid">
              {pendingAttachments.map((attachment) => (
                <div key={attachment.id} className="pending-attachment-card">
                  <img src={attachment.previewUrl} alt={attachment.file.name} loading="lazy" />
                  <div className="pending-attachment-meta">
                    <span>{attachment.file.name}</span>
                    <button
                      type="button"
                      onClick={() => removePendingAttachment(attachment.id)}
                      disabled={isUploading}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {composerError && (
            <p className="composer-error">{composerError}</p>
          )}
        </div>
        <button
          type="submit"
          disabled={isSubmitDisabled}
          className="send-btn"
        >
          {(isStreaming || isUploading) ? (
            <span className="spinner" />
          ) : (
            <span>Send</span>
          )}
        </button>
      </form>
    </div>
  );
}

function MessageRow({ msg, assistantAvatar, copiedCodeBlockId, onCopyCode }: MessageRowProps) {
  const renderedScreenshotFilenames = new Set<string>();

  return (
    <div className={`message ${msg.role} animate-slide-in`}>
      <div className="message-avatar" aria-hidden="true">
        {msg.role === 'user' ? 'U' : assistantAvatar}
      </div>
      <div className="message-content">
        <div className="message-header">
          <span className="message-role">
            {msg.role === 'user' ? 'You' : 'Keygate'}
          </span>
          <span className="message-time">
            {msg.timestamp.toLocaleTimeString()}
          </span>
        </div>
        <div className="message-bubble">
          <div className="message-rendered">
            {msg.attachments && msg.attachments.length > 0 && (
              <div className="message-upload-list">
                {msg.attachments.map((attachment) => (
                  <a
                    key={attachment.id}
                    href={attachment.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="message-upload-item"
                  >
                    <img
                      src={attachment.url}
                      alt={attachment.filename}
                      className="message-upload-image"
                      loading="lazy"
                    />
                    <span>{attachment.filename}</span>
                  </a>
                ))}
              </div>
            )}

            {parseMessageSegments(msg.content).map((segment, segmentIndex) => {
              const key = `${msg.id}:${segmentIndex}`;
              if (segment.type === 'text') {
                if (segment.content.length === 0) {
                  return null;
                }

                const screenshotRefs = (msg.role === 'assistant'
                  ? extractScreenshotFilenamesFromText(segment.content)
                  : [])
                  .filter((screenshotRef) => {
                    const dedupeKey = screenshotRef.filename.toLowerCase();
                    if (renderedScreenshotFilenames.has(dedupeKey)) {
                      return false;
                    }

                    renderedScreenshotFilenames.add(dedupeKey);
                    return true;
                  });

                return (
                  <div key={key} className="message-text">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={CHAT_MARKDOWN_COMPONENTS}
                    >
                      {segment.content}
                    </ReactMarkdown>
                    {screenshotRefs.length > 0 && (
                      <div className="message-screenshot-list">
                        {screenshotRefs.map((screenshotRef) => {
                          const screenshotUrl = buildScreenshotImageUrl(screenshotRef.filename);
                          return (
                            <span
                              key={`${msg.id}:${segmentIndex}:${screenshotRef.filename}`}
                              className="message-screenshot-inline"
                            >
                              <a
                                href={screenshotUrl}
                                target="_blank"
                                rel="noreferrer noopener"
                              >
                                {screenshotRef.filename}
                              </a>
                              <img
                                src={screenshotUrl}
                                alt={`Browser screenshot for ${screenshotRef.sessionId}`}
                                className="message-screenshot-image"
                                loading="lazy"
                              />
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              }

              const blockId = `${msg.id}:code:${segmentIndex}`;
              return (
                <div key={key} className="code-block">
                  <div className="code-block-header">
                    <span className="code-block-language">
                      {segment.language ?? 'text'}
                    </span>
                    <button
                      type="button"
                      className="code-copy-btn"
                      onClick={() => onCopyCode(blockId, segment.content)}
                    >
                      {copiedCodeBlockId === blockId ? 'Copied' : 'Copy code'}
                    </button>
                  </div>
                  <pre>
                    <code>{segment.content}</code>
                  </pre>
                </div>
              );
            })}
          </div>
          {msg.id === 'streaming' && (
            <span className="cursor-blink">|</span>
          )}
        </div>
      </div>
    </div>
  );
}

function parseUploadedAttachment(value: unknown): UploadedAttachment | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const payload = value as Record<string, unknown>;
  const id = typeof payload['id'] === 'string' ? payload['id'].trim() : '';
  const filename = typeof payload['filename'] === 'string' ? payload['filename'].trim() : '';
  const contentType = typeof payload['contentType'] === 'string' ? payload['contentType'].trim() : '';
  const url = typeof payload['url'] === 'string' ? payload['url'].trim() : '';
  const sizeBytes = Number.parseInt(String(payload['sizeBytes'] ?? ''), 10);

  if (!id || !filename || !contentType || !url || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return null;
  }

  return {
    id,
    filename,
    contentType,
    sizeBytes,
    url,
  };
}

async function extractUploadError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as Record<string, unknown>;
    if (typeof payload['error'] === 'string' && payload['error'].trim().length > 0) {
      return payload['error'];
    }
  } catch {
    // Ignore JSON parse errors and fallback below.
  }

  return `Image upload failed (${response.status}).`;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below.
    }
  }

  if (typeof document === 'undefined') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }

  return copied;
}
