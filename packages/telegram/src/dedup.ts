/**
 * Prevents double-processing of updates (e.g. during network hiccups with long polling).
 */
export class UpdateDeduplicator {
  private readonly seen = new Set<number>();
  private watermark = 0;

  isDuplicate(updateId: number): boolean {
    return this.seen.has(updateId);
  }

  markSeen(updateId: number): void {
    this.seen.add(updateId);
    if (updateId > this.watermark) {
      this.watermark = updateId;
    }
    // Prune old entries to keep memory bounded
    if (this.seen.size > 2000) {
      const threshold = this.watermark - 1000;
      for (const id of this.seen) {
        if (id < threshold) {
          this.seen.delete(id);
        }
      }
    }
  }
}
