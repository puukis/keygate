import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../brain/Brain.js', () => ({
  Brain: class MockBrain {
    async *runStream() {
      yield 'webhook-ok';
    }

    getLLMModel() {
      return 'mock-model';
    }

    async listModels() {
      return [{ id: 'mock-model', provider: 'ollama', displayName: 'Mock', isDefault: true }];
    }

    async setLLMSelection() {}
  },
}));

vi.mock('../../db/index.js', () => ({
  Database: class MockDatabase {
    sessions = new Map<string, Record<string, unknown>>();
    getSession(sessionId: string) { return this.sessions.get(sessionId) ?? null; }
    listSessions() { return Array.from(this.sessions.values()); }
    saveSession(session: Record<string, unknown>) { this.sessions.set(session['id'] as string, session); }
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
import { WebhookService, WebhookStore, computeWebhookSignature } from '../../webhooks/index.js';

function createConfig(workspacePath: string): KeygateConfig {
  return {
    llm: { provider: 'ollama', model: 'llama3', apiKey: '', ollama: { host: 'http://127.0.0.1:11434' } },
    security: { mode: 'safe', spicyModeEnabled: false, workspacePath, allowedBinaries: ['node'] },
    server: { port: 18790 },
    browser: {
      domainPolicy: 'none', domainAllowlist: [], domainBlocklist: [], traceRetentionDays: 7,
      mcpPlaywrightVersion: '0.0.64', artifactsPath: path.join(workspacePath, '.keygate-browser-runs'),
    },
    skills: { load: { watch: false, watchDebounceMs: 250, extraDirs: [], pluginDirs: [] }, entries: {}, install: { nodeManager: 'npm' } },
    discord: { token: '', prefix: '!keygate ' },
  };
}

describe('Gateway webhook real-flow smoke', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-gw-webhook-'));
    vi.stubEnv('XDG_CONFIG_HOME', tempRoot);
  });

  afterEach(async () => {
    Gateway.reset();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('accepts signed webhook and dispatches into session pipeline', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-gw-webhook-workspace-'));
    const gateway = Gateway.getInstance(createConfig(workspace));
    const session = gateway.createWebSession();

    const store = new WebhookStore();
    const service = new WebhookService(store, async (sessionId, content) => {
      await gateway.sendMessageToSession(sessionId, content, 'webhook:test');
    });

    const route = await service.createRoute({ name: 'github', sessionId: session.id, promptPrefix: '[HOOK]' });
    const body = JSON.stringify({ event: 'push', repo: 'demo' });
    const sig = computeWebhookSignature(route.secret, body);

    const result = await service.handleIncoming(route.id, body, `sha256=${sig}`);
    expect(result.accepted).toBe(true);

    const history = gateway.getSessionHistory(session.id, 10);
    expect(history.some((msg) => msg.role === 'user' && msg.content.includes('[HOOK]'))).toBe(true);
    expect(history.some((msg) => msg.role === 'assistant' && msg.content.includes('webhook-ok'))).toBe(true);
  });
});
