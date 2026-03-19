import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { request as httpRequest } from 'node:http';
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
    security: {
      mode: 'safe', spicyModeEnabled: false, workspacePath, allowedBinaries: ['node'],
      sandbox: { backend: 'docker', scope: 'session', image: 'node:20-slim', networkAccess: false, degradeWithoutDocker: true },
    },
    server: { host: '127.0.0.1', port, apiToken: '' },
    remote: {
      authMode: 'off',
      tailscale: { resetOnStop: false },
      ssh: { port: 22, localPort: 28790, remotePort: 18790 },
    },
    browser: {
      domainPolicy: 'none', domainAllowlist: [], domainBlocklist: [], traceRetentionDays: 7,
      mcpPlaywrightVersion: '0.0.64', artifactsPath: path.join(workspacePath, '.keygate-browser-runs'),
    },
    skills: { load: { watch: false, watchDebounceMs: 250, extraDirs: [], pluginDirs: [] }, entries: {}, install: { nodeManager: 'npm' } },
    discord: { token: '', prefix: '!keygate ' },
  };
}

function createProtectedConfig(workspacePath: string, port: number): KeygateConfig {
  return {
    ...createConfig(workspacePath, port),
    server: {
      host: '127.0.0.1',
      port,
      apiToken: 'test-operator-token',
    },
    remote: {
      authMode: 'token',
      tailscale: { resetOnStop: false },
      ssh: { port: 22, localPort: 28790, remotePort: 18790 },
    },
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

    const ws = await connectWs(`ws://127.0.0.1:${port}/ws`);
    const connected = await waitForType(ws, 'connected');
    const webSessionId = `web:${connected.sessionId}`;

    ws.send(JSON.stringify({ type: 'message', content: 'bootstrap session' }));
    await waitForType(ws, 'session_user_message');
    await waitForType(ws, 'message_received');

    ws.send(JSON.stringify({ type: 'git_status' }));
    const gitStatus = await waitForType(ws, 'git_status_result');
    expect(gitStatus.state.isRepo).toBe(true);
    expect(gitStatus.state.branch).toBe('main');

    ws.send(JSON.stringify({ type: 'routing_create', scope: 'web', chatId: connected.sessionId, agentKey: 'ops' }));
    const routingCreated = await waitForType(ws, 'routing_create_result');
    expect(routingCreated.rule.agentKey).toBe('ops');

    ws.send(JSON.stringify({ type: 'message', content: 'normal routed message probe' }));
    const routedProbe = await waitForType(ws, 'session_user_message');
    await waitForType(ws, 'message_received');
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
    const authToken = pairApproved.node.authToken;

    ws.send(JSON.stringify({
      type: 'node_register',
      nodeId,
      authToken,
      platform: 'darwin',
      version: '1.0.0',
      permissions: { screen: 'granted', notify: 'granted' },
    }));
    const registered = await waitForType(ws, 'node_register_result');
    expect(registered.node.id).toBe(nodeId);

    ws.send(JSON.stringify({ type: 'node_invoke', nodeId, capability: 'screen' }));
    const denied = await waitForType(ws, 'node_invoke_result');
    expect(denied.result.ok).toBe(false);

    ws.send(JSON.stringify({ type: 'node_invoke', nodeId, capability: 'screen', highRiskAck: true }));
    const invokeRequest = await waitForType(ws, 'node_invoke_request');
    expect(invokeRequest.capability).toBe('screen');
    ws.send(JSON.stringify({
      type: 'node_invoke_response',
      requestId: invokeRequest.requestId,
      nodeId,
      capability: 'screen',
      ok: true,
      message: 'captured',
      payload: { imageAttachmentId: 'attachment-demo' },
    }));
    const allowed = await waitForType(ws, 'node_invoke_result');
    expect(allowed.result.ok).toBe(true);

    ws.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }, 20_000);

  it('reports occupied startup ports through onError without crashing', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-e2e-portbusy-'));
    const port = 19100 + Math.floor(Math.random() * 200);

    let listeningResolve: (() => void) | null = null;
    const listeningPromise = new Promise<void>((resolve) => { listeningResolve = resolve; });

    const firstHandle = startWebServer(createConfig(workspace, port), { onListening: () => listeningResolve?.() });
    handles.push(firstHandle);
    await listeningPromise;

    let errorResolve: ((error: Error) => void) | null = null;
    const errorPromise = new Promise<Error>((resolve) => { errorResolve = resolve; });

    const secondHandle = startWebServer(createConfig(workspace, port), {
      onError: (error) => errorResolve?.(error),
    });
    handles.push(secondHandle);

    const startupError = await errorPromise;
    expect(startupError.message).toContain(`127.0.0.1:${port}`);
    expect(startupError.message).toContain('already in use');

    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('accepts signed webhook over HTTP and routes into session', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-e2e-webhook-'));
    const port = 19350 + Math.floor(Math.random() * 200);

    let listeningResolve: (() => void) | null = null;
    const listeningPromise = new Promise<void>((resolve) => { listeningResolve = resolve; });

    const handle = startWebServer(createConfig(workspace, port), { onListening: () => listeningResolve?.() });
    handles.push(handle);
    await listeningPromise;

    const ws = await connectWs(`ws://127.0.0.1:${port}/ws`);
    const connected = await waitForType(ws, 'connected');

    ws.send(JSON.stringify({ type: 'message', content: 'bootstrap session' }));
    const bootstrapMsg = await waitForType(ws, 'session_user_message');
    await waitForType(ws, 'message_received');
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

  it('renders operator command responses through session events', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-e2e-command-'));
    const port = 19150 + Math.floor(Math.random() * 200);

    let listeningResolve: (() => void) | null = null;
    const listeningPromise = new Promise<void>((resolve) => { listeningResolve = resolve; });

    const handle = startWebServer(createConfig(workspace, port), { onListening: () => listeningResolve?.() });
    handles.push(handle);
    await listeningPromise;

    const ws = await connectWs(`ws://127.0.0.1:${port}/ws`);
    await waitForType(ws, 'connected');

    ws.send(JSON.stringify({ type: 'message', content: '/status' }));
    const response = await waitForType(ws, 'session_message_end');
    expect(String(response.content ?? '')).toContain('Session status:');

    ws.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }, 20_000);

  it('requires operator auth for the protected operator surface when remote auth is enabled', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-e2e-auth-'));
    const port = 19400 + Math.floor(Math.random() * 200);

    let listeningResolve: (() => void) | null = null;
    const listeningPromise = new Promise<void>((resolve) => { listeningResolve = resolve; });

    const handle = startWebServer(createProtectedConfig(workspace, port), { onListening: () => listeningResolve?.() });
    handles.push(handle);
    await listeningPromise;

    const unauthorizedStatus = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(unauthorizedStatus.status).toBe(401);

    const unauthorizedBrowser = await fetch(`http://127.0.0.1:${port}/api/browser/latest?sessionId=web%3Atest`, {
      method: 'HEAD',
    });
    expect(unauthorizedBrowser.status).toBe(401);

    const unauthorizedUpload = await fetch(`http://127.0.0.1:${port}/api/uploads/image?sessionId=web%3Atest&id=missing`, {
      method: 'HEAD',
    });
    expect(unauthorizedUpload.status).toBe(401);

    await expect(getWebSocketUpgradeStatus(`http://127.0.0.1:${port}/ws`)).resolves.toBe(401);

    const webhookResponse = await fetch(`http://127.0.0.1:${port}/api/webhooks/missing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ping: true }),
    });
    expect(webhookResponse.status).not.toBe(401);

    const gmailPushResponse = await fetch(`http://127.0.0.1:${port}/api/gmail/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: { data: 'test' } }),
    });
    expect(gmailPushResponse.status).toBe(401);
    await expect(gmailPushResponse.json()).resolves.toMatchObject({
      message: 'Missing Google OIDC bearer token',
    });

    const pluginResponse = await fetch(`http://127.0.0.1:${port}/api/plugins/missing`);
    expect(pluginResponse.status).toBe(404);

    const loginResponse = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-operator-token',
      },
    });
    expect(loginResponse.status).toBe(204);
    const cookie = loginResponse.headers.get('set-cookie');
    expect(cookie).toContain('keygate_operator_session=');
    const authorizedBrowser = await fetch(`http://127.0.0.1:${port}/api/browser/latest?sessionId=web%3Atest`, {
      method: 'HEAD',
      headers: {
        Cookie: cookie ?? '',
      },
    });
    expect(authorizedBrowser.status).not.toBe(401);

    const ws = await connectWs(`ws://127.0.0.1:${port}/ws`, {
      headers: {
        Cookie: cookie ?? '',
      },
    });
    await waitForType(ws, 'connected');
    ws.close();

    const logoutResponse = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
      method: 'DELETE',
      headers: {
        Cookie: cookie ?? '',
      },
    });
    expect(logoutResponse.status).toBe(204);

    const afterLogout = await fetch(`http://127.0.0.1:${port}/api/browser/latest?sessionId=web%3Atest`, {
      method: 'HEAD',
      headers: {
        Cookie: cookie ?? '',
      },
    });
    expect(afterLogout.status).toBe(401);

    await fs.rm(workspace, { recursive: true, force: true });
  }, 20_000);
});

type WsWithBuffer = WebSocket & { __buffer?: any[] };

async function connectWs(
  url: string,
  options?: { headers?: Record<string, string> },
): Promise<WsWithBuffer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options) as WsWithBuffer;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error('WebSocket connection timed out'));
    }, 4_000);
    const settleReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const settleResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(ws);
    };

    ws.__buffer = [];
    ws.on('message', (raw: Buffer) => {
      try {
        ws.__buffer?.push(JSON.parse(raw.toString('utf8')));
      } catch {
        // ignore
      }
    });

    ws.once('open', settleResolve);
    ws.once('unexpected-response', (_request, response) => {
      settleReject(new Error(`Unexpected server response: ${response.statusCode}`));
    });
    ws.once('close', (code) => {
      settleReject(new Error(`WebSocket closed before connect: ${code}`));
    });
    ws.once('error', (error) => {
      settleReject(error instanceof Error ? error : new Error(String(error)));
    });
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

async function getWebSocketUpgradeStatus(url: string): Promise<number> {
  const parsed = new URL(url);

  return new Promise((resolve, reject) => {
    const req = httpRequest({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('keygate-test').toString('base64'),
      },
    });

    req.once('response', (response) => {
      resolve(response.statusCode ?? 0);
      response.resume();
    });
    req.once('upgrade', () => {
      resolve(101);
    });
    req.once('error', reject);
    req.end();
  });
}
