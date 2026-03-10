import type { Api } from 'grammy';

/**
 * Sends "typing" chat action every 4 seconds.
 * Includes a 401 circuit-breaker: if the token is revoked, stop silently.
 */
export class TypingIndicator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly messageThreadId?: number,
  ) {}

  start(): void {
    if (this.stopped) return;
    void this.send();
    this.timer = setInterval(() => {
      if (!this.stopped) void this.send();
    }, 4000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async send(): Promise<void> {
    try {
      await this.api.sendChatAction(
        this.chatId,
        'typing',
        this.messageThreadId !== undefined ? { message_thread_id: this.messageThreadId } : undefined,
      );
    } catch (error: unknown) {
      // Stop on 401 (invalid token) to avoid spamming logs
      const isUnauthorized =
        error instanceof Error &&
        (error.message.includes('401') || error.message.toLowerCase().includes('unauthorized'));
      if (isUnauthorized) {
        this.stop();
      }
      // All other errors are transient; ignore them
    }
  }
}
