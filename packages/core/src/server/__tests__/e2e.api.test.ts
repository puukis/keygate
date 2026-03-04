import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../brain/Brain.js', () => ({
  Brain: class MockBrain {
    async *runStream() {
      yield 'e2e-ok';
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

import { startWebServer } from '../index.js';
import { computeWebhookSignature } from '../../webhooks/signature.js';
import type { KeygateConfig } from '../../types.js';

function createConfig(workspacePath: string, port: number): KeygateConfig {
  return {
    llm: { provider: 'ollama', model: 'llama3', apiKey: '', ollama: { host: 'http://127.0.0.1:11434' } },
    security: { mode: 'safe', spicyModeEnabled: false, workspacePath, allowedBinaries: ['node'] },
    server: { port },
    browser: {
      domainPolicy: 'none', domainAllowlist: [], domainBlocklist: [], traceRetentionDays: 7,
      mcpPlaywrightVersion: '0.0.64', artifactsPath: path.join(workspacePath, '.keygate-browser-runs'),
    },
    skills: { load: { watch: false, watchDebounceMs: 250, extraDirs: [], pluginDirs: [] }, entries: {}, install: { nodeManager: 'npm' } },
    discord: { token: '', prefix: '!keygate ' },
  };
}

describe('server e2e api flows', () => {
  const handles: Array<{ close: () => Promise<void> }> = [];
  let configRoot = '';

  beforeEach(async () => {
    configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-e2e-config-'));
    vi.stubEnv('HOME', configRoot);
    vi.stubEnv('USERPROFILE', configRoot);
    vi.stubEnv('XDG_CONFIG_HOME', configRoot);
  });

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) await handle.close();
    }
    vi.unstubAllEnvs();
    if (configRoot) {
      await fs.rm(configRoot, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('exercises routing/scheduler/node APIs over websocket', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-e2e-ws-'));
    const port = 19100 + Math.floor(Math.random() * 200);

    let listeningResolve: (() => void) | null = null;
    const listeningPromise = new Promise<void>((resolve) => { listeningResolve = resolve; });

    const handle = startWebServer(createConfig(workspace, port), { onListening: () => listeningResolve?.() });
    handles.push(handle);
    await listeningPromise;

    const ws = await connectWs(`ws://127.0.0.1:${port}`);
    const connected = await waitForType(ws, 'connected');
    const webSessionId = `web:${connected.sessionId}`;

    ws.send(JSON.stringify({ type: 'message', content: 'bootstrap session' }));
    await waitForType(ws, 'message_received');
    await waitForType(ws, 'session_user_message');

    ws.send(JSON.stringify({ type: 'routing_create', scope: 'web', chatId: connected.sessionId, agentKey: 'ops' }));
    const routingCreated = await waitForType(ws, 'routing_create_result');
    expect(routingCreated.rule.agentKey).toBe('ops');

    ws.send(JSON.stringify({ type: 'message', content: 'normal routed message probe' }));
    await waitForType(ws, 'message_received');
    const routedProbe = await waitForType(ws, 'session_user_message');
    expect(String(routedProbe.sessionId ?? '')).toContain('web:ops:');
    const routedSessionId = String(routedProbe.sessionId);

    ws.send(JSON.stringify({ type: 'scheduler_create', sessionId: routedSessionId, cronExpression: '* * * * *', prompt: 'scheduled e2e ping' }));
    const schedulerCreated = await waitForType(ws, 'scheduler_create_result');
    const jobId = schedulerCreated.job.id;
    expect(jobId).toBeTruthy();

    ws.send(JSON.stringify({ type: 'scheduler_trigger', jobId }));
    const triggered = await waitForType(ws, 'scheduler_trigger_result');
    expect(triggered.job.id).toBe(jobId);

    const userMsg = await waitForType(ws, 'session_user_message');
    expect(String(userMsg.content ?? '')).toContain('scheduled e2e ping');

    ws.send(JSON.stringify({ type: 'node_pair_request', nodeName: 'Pixel7', capabilities: ['screen', 'notify'] }));
    const pairReq = await waitForType(ws, 'node_pair_request_result');
    expect(pairReq.request.requestId).toBeTruthy();

    ws.send(JSON.stringify({ type: 'node_pair_approve', requestId: pairReq.request.requestId, pairingCode: pairReq.request.pairingCode }));
    const pairApproved = await waitForType(ws, 'node_pair_approve_result');
    const nodeId = pairApproved.node.id;

    ws.send(JSON.stringify({ type: 'node_invoke', nodeId, capability: 'screen' }));
    const denied = await waitForType(ws, 'node_invoke_result');
    expect(denied.result.ok).toBe(false);

    ws.send(JSON.stringify({ type: 'node_invoke', nodeId, capability: 'screen', highRiskAck: true }));
    const allowed = await waitForType(ws, 'node_invoke_result');
    expect(allowed.result.ok).toBe(true);

    ws.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }, 20_000);

  it('accepts signed webhook over HTTP and routes into session', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-e2e-webhook-'));
    const port = 19350 + Math.floor(Math.random() * 200);

    let listeningResolve: (() => void) | null = null;
    const listeningPromise = new Promise<void>((resolve) => { listeningResolve = resolve; });

    const handle = startWebServer(createConfig(workspace, port), { onListening: () => listeningResolve?.() });
    handles.push(handle);
    await listeningPromise;

    const ws = await connectWs(`ws://127.0.0.1:${port}`);
    const connected = await waitForType(ws, 'connected');

    ws.send(JSON.stringify({ type: 'message', content: 'bootstrap session' }));
    await waitForType(ws, 'message_received');
    const bootstrapMsg = await waitForType(ws, 'session_user_message');
    const activeSessionId = String(bootstrapMsg.sessionId);

    ws.send(JSON.stringify({ type: 'webhook_create', name: 'github', sessionId: activeSessionId, promptPrefix: '[E2EHOOK]' }));
    const created = await waitForType(ws, 'webhook_create_result');

    const body = JSON.stringify({ event: 'push', branch: 'main' });
    const signature = computeWebhookSignature(created.route.secret, body);
    const response = await fetch(`http://127.0.0.1:${port}/api/webhooks/${created.route.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-keygate-signature': `sha256=${signature}`,
      },
      body,
    });

    expect(response.status).toBe(202);
    const userMsg = await waitForType(ws, 'session_user_message');
    expect(String(userMsg.content ?? '')).toContain('[E2EHOOK]');
    expect(String(userMsg.content ?? '')).toContain('push');

    ws.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }, 20_000);
});

type WsWithBuffer = WebSocket & { __buffer?: any[] };

async function connectWs(url: string): Promise<WsWithBuffer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url) as WsWithBuffer;
    ws.__buffer = [];
    ws.on('message', (raw: Buffer) => {
      try {
        ws.__buffer?.push(JSON.parse(raw.toString('utf8')));
      } catch {
        // ignore
      }
    });

    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function waitForType(ws: WsWithBuffer, type: string): Promise<any> {
  const timeoutMs = 10_000;
  const started = Date.now();

  while (Date.now() - started <= timeoutMs) {
    const buffer = ws.__buffer ?? [];
    const idx = buffer.findIndex((item) => item?.type === type);
    if (idx >= 0) {
      const [matched] = buffer.splice(idx, 1);
      return matched;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for WS type: ${type}`);
}
