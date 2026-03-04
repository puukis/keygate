import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SchedulerStore } from '../store.js';

describe('SchedulerStore', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-scheduler-store-'));
    vi.stubEnv('HOME', tempRoot);
    vi.stubEnv('USERPROFILE', tempRoot);
    vi.stubEnv('XDG_CONFIG_HOME', tempRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects oversized prompts', async () => {
    const store = new SchedulerStore();
    await expect(store.createJob({
      sessionId: 'web:test',
      cronExpression: '* * * * *',
      prompt: 'x'.repeat(8_001),
    })).rejects.toThrow(/prompt exceeds/);
  });

  it('creates, updates and deletes a job persistently', async () => {
    const store = new SchedulerStore();
    const created = await store.createJob({
      sessionId: 'web:test',
      cronExpression: '* * * * *',
      prompt: 'hello',
    });

    expect(created.id).toBeTruthy();
    expect(created.nextRunAt).toBeTruthy();

    const updated = await store.updateJob(created.id, { sessionId: 'web:other', enabled: false, prompt: 'updated prompt' });
    expect(updated.sessionId).toBe('web:other');
    expect(updated.enabled).toBe(false);
    expect(updated.nextRunAt).toBeNull();
    expect(updated.prompt).toBe('updated prompt');

    const listed = await store.listJobs();
    expect(listed).toHaveLength(1);

    const deleted = await store.deleteJob(created.id);
    expect(deleted).toBe(true);
    expect(await store.listJobs()).toHaveLength(0);
  });
});
