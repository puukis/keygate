import type { ScheduledJob, SchedulerStore } from './store.js';

interface SchedulerStoreLike {
  listJobs(): Promise<ScheduledJob[]>;
  markTriggered(jobId: string, firedAt?: Date): Promise<ScheduledJob>;
}

interface SchedulerServiceOptions {
  pollIntervalMs?: number;
  now?: () => Date;
}

export class SchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticking = false;

  constructor(
    private readonly store: SchedulerStoreLike,
    private readonly executeJob: (job: ScheduledJob) => Promise<void>,
    private readonly options: SchedulerServiceOptions = {},
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.scheduleNextTick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async runDueJobs(): Promise<number> {
    if (this.ticking) {
      return 0;
    }

    this.ticking = true;
    try {
      const now = this.getNow();
      const jobs = await this.store.listJobs();
      const due = jobs.filter((job) => job.enabled && job.nextRunAt && Date.parse(job.nextRunAt) <= now.getTime());

      for (const job of due) {
        const marked = await this.store.markTriggered(job.id, now);
        try {
          await this.executeJob(marked);
        } catch (error) {
          console.error('Scheduled job execution failed:', error);
        }
      }

      return due.length;
    } finally {
      this.ticking = false;
    }
  }

  private scheduleNextTick(): void {
    if (!this.running) {
      return;
    }

    const pollIntervalMs = this.options.pollIntervalMs ?? 1_000;
    const nowMs = this.getNow().getTime();
    const nextDelay = Math.max(25, pollIntervalMs - (nowMs % pollIntervalMs));

    this.timer = setTimeout(async () => {
      await this.runDueJobs();
      this.scheduleNextTick();
    }, nextDelay);
  }

  private getNow(): Date {
    return this.options.now ? this.options.now() : new Date();
  }
}

export function createSchedulerService(
  store: SchedulerStore,
  executeJob: (job: ScheduledJob) => Promise<void>,
  options?: SchedulerServiceOptions,
): SchedulerService {
  return new SchedulerService(store, executeJob, options);
}
