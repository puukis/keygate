import type { Api } from 'grammy';
import { markdownToTelegramHtml, chunkHtml } from './format.js';

const EDIT_INTERVAL_MS = 1000;
const MAX_LEN = 4000;

/**
 * Edit-in-place streaming for Telegram.
 * Sends an initial placeholder message, then edits it as chunks arrive.
 * If the response exceeds the limit, sends additional messages.
 */
export class StreamReply {
  private sentMessageId: number | null = null;
  private lastEditAt = 0;
  private buffer = '';
  private editFailed = false;
  private segmentStart = 0;
  private pendingSegment: { replyToMsgId: number; segmentStart: number } | null = null;

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private replyToMsgId: number,
    private readonly messageThreadId?: number,
  ) {}

  async initialize(): Promise<boolean> {
    try {
      const opts: Record<string, unknown> = {
        reply_parameters: { message_id: this.replyToMsgId },
      };
      if (this.messageThreadId !== undefined) {
        opts['message_thread_id'] = this.messageThreadId;
      }

      const sent = await this.api.sendMessage(this.chatId, '…', opts as Parameters<Api['sendMessage']>[2]);
      this.sentMessageId = sent.message_id;
      return true;
    } catch (e) {
      console.error('[StreamReply] initialize() failed, falling back to standard sends:', e);
      return false;
    }
  }

  async update(newBuffer: string): Promise<void> {
    this.buffer = newBuffer;
    const moved = await this.maybeStartPendingSegment();
    if (!moved && this.pendingSegment) {
      return;
    }
    const now = Date.now();
    if (now - this.lastEditAt < EDIT_INTERVAL_MS) return;
    const delivered = await this.editCurrent();
    if (delivered) {
      this.lastEditAt = now;
    }
  }

  async finalize(finalBuffer: string): Promise<boolean> {
    this.buffer = finalBuffer;
    const moved = await this.maybeStartPendingSegment();
    if (!moved && this.pendingSegment) {
      return true;
    }
    return this.editCurrent();
  }

  async continueBelow(replyToMsgId: number): Promise<void> {
    this.pendingSegment = {
      replyToMsgId,
      segmentStart: this.buffer.length,
    };

    // If no content was shown yet, remove the old placeholder so the visible
    // assistant response can restart underneath the confirmation prompt.
    if (this.buffer.length === 0 && this.sentMessageId !== null) {
      try {
        await this.api.deleteMessage(this.chatId, this.sentMessageId);
      } catch (error) {
        console.warn('[StreamReply] deleteMessage() failed while moving continuation:', error);
      }
      this.sentMessageId = null;
      this.lastEditAt = 0;
      this.editFailed = false;
    }
  }

  private async maybeStartPendingSegment(): Promise<boolean> {
    if (!this.pendingSegment) {
      return true;
    }

    if (this.buffer.length <= this.pendingSegment.segmentStart) {
      return false;
    }

    this.replyToMsgId = this.pendingSegment.replyToMsgId;
    this.segmentStart = this.pendingSegment.segmentStart;
    this.pendingSegment = null;
    this.sentMessageId = null;
    this.lastEditAt = 0;
    this.editFailed = false;

    return this.initialize();
  }

  private async editCurrent(): Promise<boolean> {
    if (this.sentMessageId === null || this.editFailed) {
      return false;
    }

    const segmentBuffer = this.buffer.slice(this.segmentStart);
    const html = markdownToTelegramHtml(segmentBuffer);

    if (html.length <= MAX_LEN) {
      try {
        await this.api.editMessageText(this.chatId, this.sentMessageId, html || '…', {
          parse_mode: 'HTML',
        });
        return true;
      } catch (error) {
        if (isMessageNotModifiedError(error)) {
          return true;
        }
        this.editFailed = true;
        console.error('[StreamReply] editMessageText() failed:', error);
        return false;
      }
    }

    // Content exceeds limit — edit first message with first chunk, send remainder
    const chunks = chunkHtml(html, MAX_LEN);
    const first = chunks[0] ?? '';
    try {
      await this.api.editMessageText(this.chatId, this.sentMessageId, first, {
        parse_mode: 'HTML',
      });
    } catch (error) {
      if (!isMessageNotModifiedError(error)) {
        this.editFailed = true;
        console.error('[StreamReply] editMessageText() failed for overflow reply:', error);
        return false;
      }
    }

    for (const chunk of chunks.slice(1)) {
      try {
        const opts: Record<string, unknown> = {};
        if (this.messageThreadId !== undefined) {
          opts['message_thread_id'] = this.messageThreadId;
        }
        await this.api.sendMessage(this.chatId, chunk, {
          parse_mode: 'HTML',
          ...opts,
        } as Parameters<Api['sendMessage']>[2]);
      } catch (error) {
        this.editFailed = true;
        console.error('[StreamReply] sendMessage() failed for overflow reply:', error);
        return false;
      }
    }

    return true;
  }
}

function isMessageNotModifiedError(error: unknown): boolean {
  return error instanceof Error && /message is not modified/i.test(error.message);
}
