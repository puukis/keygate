import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../brain/Brain.js', () => ({
  Brain: class MockBrain {
    async *runStream() {
      yield 'scheduled-ok';
    }

    getLLMModel() {
      return 'mock-model';
    }

    async listModels() {
      return [{ id: 'mock-model', provider: 'ollama', displayName: 'Mock', isDefault: true }];
    }

    async setLLMSelection() {
      // noop
    }
  },
}));

const mockDbState = vi.hoisted(() => ({
  instances: [] as Array<{
    sessions: Map<string, Record<string, unknown>>;
  }>,
}));

vi.mock('../../db/index.js', () => ({
  Database: class MockDatabase {
    sessions = new Map<string, Record<string, unknown>>();

    constructor() {
      mockDbState.instances.push(this);
    }

    getSession(sessionId: string) {
      return this.sessions.get(sessionId) ?? null;
    }

    listSessions() {
      return Array.from(this.sessions.values());
    }

    saveSession(session: Record<string, unknown>) {
      this.sessions.set(session['id'] as string, session);
    }

    saveMessage() {}
    clearSession() {}
    deleteSession(sessionId: string) { this.sessions.delete(sessionId); }
    updateSessionTitle() {}
    getSessionAttachmentPaths() { return []; }
    close() {}
  },
}));

import { Gateway } from '../Gateway.js';
import type { KeygateConfig } from '../../types.js';

function createConfig(workspacePath: string): KeygateConfig {
  return {
    llm: {
      provider: 'ollama',
      model: 'llama3',
      apiKey: '',
      ollama: { host: 'http://127.0.0.1:11434' },
    },
    security: {
      mode: 'safe',
      spicyModeEnabled: false,
      workspacePath,
      allowedBinaries: ['node'],
    },
    server: { port: 18790 },
    browser: {
      domainPolicy: 'none',
      domainAllowlist: [],
      domainBlocklist: [],
      traceRetentionDays: 7,
      mcpPlaywrightVersion: '0.0.64',
      artifactsPath: path.join(workspacePath, '.keygate-browser-runs'),
    },
    skills: {
      load: {
        watch: false,
        watchDebounceMs: 250,
        extraDirs: [],
        pluginDirs: [],
      },
      entries: {},
      install: { nodeManager: 'npm' },
    },
    discord: { token: '', prefix: '!keygate ' },
  };
}

describe('Gateway scheduler real-flow smoke', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-gw-scheduler-'));
    vi.stubEnv('HOME', tempRoot);
    vi.stubEnv('USERPROFILE', tempRoot);
    vi.stubEnv('XDG_CONFIG_HOME', tempRoot);
  });

  afterEach(async () => {
    Gateway.reset();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    mockDbState.instances = [];
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('triggers scheduled job and writes to target session history', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-gw-scheduler-workspace-'));
    const gateway = Gateway.getInstance(createConfig(workspace));
    const session = gateway.createWebSession();

    const job = await gateway.createScheduledJob({
      sessionId: session.id,
      cronExpression: '* * * * *',
      prompt: 'scheduled ping',
      enabled: true,
    });

    await gateway.triggerScheduledJob(job.id);

    const history = gateway.getSessionHistory(session.id, 10);
    expect(history.some((msg) => msg.role === 'user' && msg.content === 'scheduled ping')).toBe(true);
    expect(history.some((msg) => msg.role === 'assistant' && msg.content.includes('scheduled-ok'))).toBe(true);
  });
});
