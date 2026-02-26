import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { computeNextRunAt } from './cron.js';
import { getConfigDir } from '../config/env.js';

export interface ScheduledJob {
  id: string;
  sessionId: string;
  cronExpression: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt: string | null;
}

export interface ScheduledJobCreateInput {
  sessionId: string;
  cronExpression: string;
  prompt: string;
  enabled?: boolean;
}

export interface ScheduledJobUpdateInput {
  sessionId?: string;
  cronExpression?: string;
  prompt?: string;
  enabled?: boolean;
}

interface SchedulerStorePayload {
  version: 1;
  jobs: ScheduledJob[];
}

const MAX_PROMPT_CHARS = 8_000;
const MAX_SESSION_ID_CHARS = 256;

function getStorePath(): string {
  return path.join(getConfigDir(), 'scheduler-jobs.json');
}

function defaultPayload(): SchedulerStorePayload {
  return { version: 1, jobs: [] };
}

async function loadPayload(): Promise<SchedulerStorePayload> {
  try {
    const raw = await fs.readFile(getStorePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SchedulerStorePayload>;
    const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    return {
      version: 1,
      jobs: jobs.filter((job): job is ScheduledJob => typeof job?.id === 'string' && typeof job?.sessionId === 'string'),
    };
  } catch {
    return defaultPayload();
  }
}

async function savePayload(payload: SchedulerStorePayload): Promise<void> {
  const target = getStorePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(temp, target);
}

export class SchedulerStore {
  async listJobs(): Promise<ScheduledJob[]> {
    const payload = await loadPayload();
    return payload.jobs
      .map((job) => ({ ...job }))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async getJob(jobId: string): Promise<ScheduledJob | null> {
    const payload = await loadPayload();
    const found = payload.jobs.find((job) => job.id === jobId);
    return found ? { ...found } : null;
  }

  async createJob(input: ScheduledJobCreateInput): Promise<ScheduledJob> {
    const now = new Date();
    const createdAt = now.toISOString();
    const enabled = input.enabled ?? true;
    const cronExpression = input.cronExpression.trim();
    const sessionId = input.sessionId.trim();
    const prompt = input.prompt;
    if (!sessionId || !cronExpression || !prompt.trim()) {
      throw new Error('sessionId, cronExpression, and prompt are required');
    }
    if (sessionId.length > MAX_SESSION_ID_CHARS) {
      throw new Error(`sessionId exceeds ${MAX_SESSION_ID_CHARS} characters`);
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`prompt exceeds ${MAX_PROMPT_CHARS} characters`);
    }

    const nextRunAt = enabled ? computeNextRunAt(cronExpression, now).toISOString() : null;

    const payload = await loadPayload();
    const job: ScheduledJob = {
      id: randomUUID(),
      sessionId,
      cronExpression,
      prompt,
      enabled,
      createdAt,
      updatedAt: createdAt,
      nextRunAt,
    };
    payload.jobs.push(job);
    await savePayload(payload);
    return { ...job };
  }

  async updateJob(jobId: string, patch: ScheduledJobUpdateInput): Promise<ScheduledJob> {
    const payload = await loadPayload();
    const target = payload.jobs.find((job) => job.id === jobId);
    if (!target) {
      throw new Error(`Scheduled job not found: ${jobId}`);
    }

    if (typeof patch.sessionId === 'string') {
      const sessionId = patch.sessionId.trim();
      if (!sessionId) {
        throw new Error('sessionId cannot be empty');
      }
      if (sessionId.length > MAX_SESSION_ID_CHARS) {
        throw new Error(`sessionId exceeds ${MAX_SESSION_ID_CHARS} characters`);
      }
      target.sessionId = sessionId;
    }

    if (typeof patch.cronExpression === 'string') {
      const value = patch.cronExpression.trim();
      if (!value) {
        throw new Error('cronExpression cannot be empty');
      }
      target.cronExpression = value;
    }

    if (typeof patch.prompt === 'string') {
      if (!patch.prompt.trim()) {
        throw new Error('prompt cannot be empty');
      }
      if (patch.prompt.length > MAX_PROMPT_CHARS) {
        throw new Error(`prompt exceeds ${MAX_PROMPT_CHARS} characters`);
      }
      target.prompt = patch.prompt;
    }

    if (typeof patch.enabled === 'boolean') {
      target.enabled = patch.enabled;
    }

    target.updatedAt = new Date().toISOString();
    target.nextRunAt = target.enabled
      ? computeNextRunAt(target.cronExpression, new Date()).toISOString()
      : null;

    await savePayload(payload);
    return { ...target };
  }

  async deleteJob(jobId: string): Promise<boolean> {
    const payload = await loadPayload();
    const before = payload.jobs.length;
    payload.jobs = payload.jobs.filter((job) => job.id !== jobId);
    const changed = payload.jobs.length !== before;
    if (changed) {
      await savePayload(payload);
    }
    return changed;
  }

  async markTriggered(jobId: string, firedAt = new Date()): Promise<ScheduledJob> {
    const payload = await loadPayload();
    const target = payload.jobs.find((job) => job.id === jobId);
    if (!target) {
      throw new Error(`Scheduled job not found: ${jobId}`);
    }

    target.lastRunAt = firedAt.toISOString();
    target.updatedAt = firedAt.toISOString();
    target.nextRunAt = target.enabled
      ? computeNextRunAt(target.cronExpression, firedAt).toISOString()
      : null;

    await savePayload(payload);
    return { ...target };
  }

  async setNextRunForTesting(jobId: string, nextRunAt: string): Promise<void> {
    const payload = await loadPayload();
    const target = payload.jobs.find((job) => job.id === jobId);
    if (!target) {
      throw new Error(`Scheduled job not found: ${jobId}`);
    }
    target.nextRunAt = nextRunAt;
    target.updatedAt = new Date().toISOString();
    await savePayload(payload);
  }
}
