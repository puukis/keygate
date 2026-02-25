import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockDbState = vi.hoisted(() => ({
  instances: [] as Array<{
    sessions: Map<string, Record<string, unknown>>;
    deletedSessions: string[];
    titleUpdates: Array<{ sessionId: string; title: string }>;
  }>,
}));

vi.mock('../../db/index.js', () => ({
  Database: class MockDatabase {
    sessions = new Map<string, Record<string, unknown>>();
    deletedSessions: string[] = [];
    titleUpdates: Array<{ sessionId: string; title: string }> = [];

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

    deleteSession(sessionId: string) {
      this.sessions.delete(sessionId);
      this.deletedSessions.push(sessionId);
    }

    updateSessionTitle(sessionId: string, title: string) {
      this.titleUpdates.push({ sessionId, title });
      const session = this.sessions.get(sessionId);
      if (session) {
        session['title'] = title;
      }
    }

    getSessionAttachmentPaths() {
      return [];
    }

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
    discord: {
      token: '',
      prefix: '!keygate ',
    },
  };
}

describe('Gateway session CRUD', () => {
  afterEach(() => {
    Gateway.reset();
    vi.restoreAllMocks();
    mockDbState.instances = [];
  });

  it('creates a web session with web: prefix', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-gw-create-'));
    const gateway = Gateway.getInstance(createConfig(workspace));

    const session = gateway.createWebSession();

    expect(session.id).toMatch(/^web:/);
    expect(session.channelType).toBe('web');
    expect(session.messages).toEqual([]);
    expect(gateway.getSession(session.id)).toBeDefined();
  });

  it('lists created sessions', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-gw-list-'));
    const gateway = Gateway.getInstance(createConfig(workspace));

    const s1 = gateway.createWebSession();
    const s2 = gateway.createWebSession();

    const sessions = gateway.listSessions();
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain(s1.id);
    expect(ids).toContain(s2.id);
  });

  it('deletes a session from memory and database', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-gw-delete-'));
    const gateway = Gateway.getInstance(createConfig(workspace));

    const session = gateway.createWebSession();
    gateway.deleteSession(session.id);

    expect(gateway.getSession(session.id)).toBeUndefined();

    const db = mockDbState.instances[0];
    expect(db?.deletedSessions).toContain(session.id);
  });

  it('deletes a web session when requested with an unprefixed id', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-gw-delete-unprefixed-'));
    const gateway = Gateway.getInstance(createConfig(workspace));

    const session = gateway.createWebSession();
    const bareSessionId = session.id.startsWith('web:') ? session.id.slice(4) : session.id;
    const deletedSessionId = gateway.deleteSession(bareSessionId);

    expect(deletedSessionId).toBe(session.id);
    expect(gateway.getSession(session.id)).toBeUndefined();

    const db = mockDbState.instances[0];
    expect(db?.deletedSessions).toContain(session.id);
  });

  it('renames a session in memory and database', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-gw-rename-'));
    const gateway = Gateway.getInstance(createConfig(workspace));

    const session = gateway.createWebSession();
    gateway.renameSession(session.id, 'My Chat');

    const updated = gateway.getSession(session.id);
    expect(updated?.title).toBe('My Chat');

    const db = mockDbState.instances[0];
    expect(db?.titleUpdates).toContainEqual({ sessionId: session.id, title: 'My Chat' });
  });

  it('renameSession succeeds even for a non-existent session (updates DB only)', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-gw-rename-missing-'));
    const gateway = Gateway.getInstance(createConfig(workspace));

    expect(() => gateway.renameSession('web:nonexistent', 'title')).not.toThrow();
  });
});
