import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('Gateway delegation', () => {
  afterEach(() => {
    Gateway.reset();
    vi.restoreAllMocks();
    mockDbState.instances = [];
  });

  it('spawns and lists delegated sessions', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-gw-delegation-'));
    const gateway = Gateway.getInstance(createConfig(workspace));
    const parent = gateway.createWebSession();

    const spawned = gateway.spawnDelegatedSession(parent.id, 'Worker A');
    expect(spawned.sessionId).toMatch(/^sub:/);
    expect(spawned.parentSessionId).toBe(parent.id);

    const listed = gateway.listDelegatedSessions(parent.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.sessionId).toBe(spawned.sessionId);
  });

  it('returns bounded history for delegated sessions', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-gw-delegation-history-'));
    const gateway = Gateway.getInstance(createConfig(workspace));
    const parent = gateway.createWebSession();
    const spawned = gateway.spawnDelegatedSession(parent.id, 'Worker H');

    const session = gateway.getSession(spawned.sessionId);
    expect(session).toBeDefined();
    session!.messages.push({ role: 'user', content: 'm1' }, { role: 'assistant', content: 'm2' });

    const history = gateway.getSessionHistory(spawned.sessionId, 1);
    expect(history).toHaveLength(1);
    expect(history[0]?.content).toBe('m2');
  });

  it('marks delegated sessions cancelled when killed', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-gw-delegation-kill-'));
    const gateway = Gateway.getInstance(createConfig(workspace));
    const parent = gateway.createWebSession();
    const spawned = gateway.spawnDelegatedSession(parent.id, 'Worker K');

    gateway.killDelegatedSession(spawned.sessionId, 'user');
    const listed = gateway.listDelegatedSessions(parent.id);
    expect(listed[0]?.status).toBe('cancelled');
  });
});
