import { describe, expect, it, vi } from 'vitest';
import { SchedulerService } from '../service.js';
import type { ScheduledJob } from '../store.js';

describe('SchedulerService', () => {
  it('executes due jobs and marks next run', async () => {
    const due: ScheduledJob = {
      id: 'job-1',
      sessionId: 'web:test',
      cronExpression: '* * * * *',
      prompt: 'scheduled prompt',
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    };

    const listJobs = vi.fn(async () => [due]);
    const markTriggered = vi.fn(async () => ({ ...due, lastRunAt: new Date().toISOString(), nextRunAt: new Date(Date.now() + 60_000).toISOString() }));
    const executeJob = vi.fn(async () => undefined);

    const service = new SchedulerService({ listJobs, markTriggered }, executeJob);
    const executedCount = await service.runDueJobs();

    expect(executedCount).toBe(1);
    expect(listJobs).toHaveBeenCalledTimes(1);
    expect(markTriggered).toHaveBeenCalledTimes(1);
    expect(executeJob).toHaveBeenCalledTimes(1);
  });
});
