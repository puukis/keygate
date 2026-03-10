import { randomUUID } from 'node:crypto';
import type { Api } from 'grammy';
import { BaseChannel, type ConfirmationDecision, type ConfirmationDetails } from '@puukis/core';
import { markdownToTelegramHtml, chunkHtml } from './format.js';
import { StreamReply } from './stream-reply.js';

const MAX_LEN = 4000;

type CallbackResolver = (decision: ConfirmationDecision) => void;

// Module-level map so the callback_query handler can resolve pending confirmations.
export const pendingConfirmations = new Map<string, CallbackResolver>();

/**
 * Telegram Channel adapter implementing the Channel interface.
 */
export class TelegramChannel extends BaseChannel {
  type = 'telegram' as const;

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly replyToMsgId: number,
    private readonly messageThreadId?: number,
  ) {
    super();
  }

  async send(content: string): Promise<void> {
    const html = markdownToTelegramHtml(content);
    const chunks = chunkHtml(html || content, MAX_LEN);

    let isFirst = true;
    for (const chunk of chunks) {
      try {
        const opts: Record<string, unknown> = { parse_mode: 'HTML' };
        if (this.messageThreadId !== undefined) {
          opts['message_thread_id'] = this.messageThreadId;
        }
        if (isFirst) {
          opts['reply_parameters'] = { message_id: this.replyToMsgId };
          isFirst = false;
        }
        await this.api.sendMessage(this.chatId, chunk, opts as Parameters<Api['sendMessage']>[2]);
      } catch {
        // Fallback: try without parse_mode in case of bad HTML
        try {
          const opts: Record<string, unknown> = {};
          if (this.messageThreadId !== undefined) {
            opts['message_thread_id'] = this.messageThreadId;
          }
          await this.api.sendMessage(this.chatId, chunk, opts as Parameters<Api['sendMessage']>[2]);
        } catch {
          // Ignore send failures
        }
      }
    }
  }

  async sendStream(stream: AsyncIterable<string>): Promise<void> {
    const streamReply = new StreamReply(
      this.api,
      this.chatId,
      this.replyToMsgId,
      this.messageThreadId,
    );
    await streamReply.initialize();

    let buffer = '';
    for await (const chunk of stream) {
      buffer += chunk;
      await streamReply.update(buffer);
    }

    await streamReply.finalize(buffer || '(No response)');
  }

  async requestConfirmation(prompt: string, details?: ConfirmationDetails): Promise<ConfirmationDecision> {
    const uuid = randomUUID();
    const detailLines: string[] = [];

    if (details?.summary) detailLines.push(`<b>Summary:</b> ${escapeHtml(details.summary)}`);
    if (details?.command) detailLines.push(`<b>Command:</b> <code>${escapeHtml(details.command)}</code>`);
    if (details?.path) detailLines.push(`<b>Path:</b> <code>${escapeHtml(details.path)}</code>`);
    if (details?.cwd) detailLines.push(`<b>CWD:</b> <code>${escapeHtml(details.cwd)}</code>`);

    const text =
      `🔒 <b>Confirmation required</b>\n\n${escapeHtml(prompt)}` +
      (detailLines.length > 0 ? `\n\n${detailLines.join('\n')}` : '');

    const keyboard = {
      inline_keyboard: [[
        { text: '✅ Allow once', callback_data: `confirm:${uuid}:allow_once` },
        { text: '♾️ Allow always', callback_data: `confirm:${uuid}:allow_always` },
        { text: '❌ Cancel', callback_data: `confirm:${uuid}:cancel` },
      ]],
    };

    try {
      const opts: Record<string, unknown> = {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      };
      if (this.messageThreadId !== undefined) {
        opts['message_thread_id'] = this.messageThreadId;
      }
      await this.api.sendMessage(this.chatId, text, opts as Parameters<Api['sendMessage']>[2]);
    } catch {
      return 'cancel';
    }

    return new Promise<ConfirmationDecision>((resolve) => {
      pendingConfirmations.set(uuid, resolve);

      // 60s timeout
      setTimeout(() => {
        if (pendingConfirmations.has(uuid)) {
          pendingConfirmations.delete(uuid);
          resolve('cancel');
          void this.api
            .sendMessage(this.chatId, '⏱️ Confirmation timed out.')
            .catch(() => {});
        }
      }, 60_000);
    });
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
