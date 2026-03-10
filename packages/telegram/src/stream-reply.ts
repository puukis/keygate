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

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly replyToMsgId: number,
    private readonly messageThreadId?: number,
  ) {}

  async initialize(): Promise<void> {
    try {
      const opts: Record<string, unknown> = {
        reply_parameters: { message_id: this.replyToMsgId },
      };
      if (this.messageThreadId !== undefined) {
        opts['message_thread_id'] = this.messageThreadId;
      }

      const sent = await this.api.sendMessage(this.chatId, '…', opts as Parameters<Api['sendMessage']>[2]);
      this.sentMessageId = sent.message_id;
    } catch {
      // If we can't send the placeholder, streaming will fall back to individual sends
    }
  }

  async update(newBuffer: string): Promise<void> {
    this.buffer = newBuffer;
    const now = Date.now();
    if (now - this.lastEditAt < EDIT_INTERVAL_MS) return;
    await this.editCurrent();
    this.lastEditAt = now;
  }

  async finalize(finalBuffer: string): Promise<void> {
    this.buffer = finalBuffer;
    await this.editCurrent();
  }

  private async editCurrent(): Promise<void> {
    if (this.sentMessageId === null) return;

    const html = markdownToTelegramHtml(this.buffer);

    if (html.length <= MAX_LEN) {
      try {
        await this.api.editMessageText(this.chatId, this.sentMessageId, html || '…', {
          parse_mode: 'HTML',
        });
      } catch {
        // Ignore: message may already match or be deleted
      }
      return;
    }

    // Content exceeds limit — edit first message with first chunk, send remainder
    const chunks = chunkHtml(html, MAX_LEN);
    const first = chunks[0] ?? '';
    try {
      await this.api.editMessageText(this.chatId, this.sentMessageId, first, {
        parse_mode: 'HTML',
      });
    } catch {
      // ignore
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
      } catch {
        // ignore
      }
    }
  }
}
