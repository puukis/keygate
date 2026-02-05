/**
 * LaneQueue - Ensures serial processing of messages per session
 * 
 * Each session gets its own queue. Messages within a session are processed
 * one at a time (FIFO), but different sessions can process in parallel.
 */
export class LaneQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;

  /**
   * Enqueue a task to be processed serially
   */
  async enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await task();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    const task = this.queue.shift();

    if (task) {
      try {
        await task();
      } finally {
        this.processing = false;
        this.processNext();
      }
    } else {
      this.processing = false;
    }
  }

  /**
   * Get the number of pending tasks in the queue
   */
  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * Check if the queue is currently processing
   */
  get isProcessing(): boolean {
    return this.processing;
  }
}
