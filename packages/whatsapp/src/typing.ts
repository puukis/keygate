import type { createWhatsAppSocket } from '@puukis/core';

const TYPING_INTERVAL_MS = 4_000;

export class WhatsAppTypingIndicator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly sock: Awaited<ReturnType<typeof createWhatsAppSocket>>['sock'],
    private readonly chatJid: string,
  ) {}

  start(): void {
    if (this.stopped) {
      return;
    }

    void this.send('composing');
    this.timer = setInterval(() => {
      if (!this.stopped) {
        void this.send('composing');
      }
    }, TYPING_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    void this.send('paused');
  }

  private async send(type: 'composing' | 'paused'): Promise<void> {
    try {
      await this.sock.sendPresenceUpdate(type, this.chatJid);
    } catch {
      // Ignore transient presence update failures.
    }
  }
}
