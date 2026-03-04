import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { CodexRpcClient } from '../../codex/CodexRpcClient.js';
import { OpenAICodexProvider } from '../OpenAICodexProvider.js';

// Mock the auth module so all tests get a valid token without disk/network access.
vi.mock('../../auth/index.js', () => ({
  readTokens: vi.fn(async () => ({
    access_token: 'test-access-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  })),
  isTokenExpired: vi.fn(() => false),
  getValidAccessToken: vi.fn(async () => 'test-access-token'),
  deleteTokens: vi.fn(async () => {}),
  runOAuthFlow: vi.fn(async () => ({ tokens: { access_token: 'new-token', expires_at: Math.floor(Date.now() / 1000) + 3600 } })),
  getTokenEndpoint: vi.fn(() => 'https://auth.openai.com/oauth/token'),
}));

class FakeChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    if (this.killed) {
      return true;
    }

    this.killed = true;
    this.emit('exit', 0, null);
    return true;
  }
}

const originalHome = process.env['HOME'];
const originalUserProfile = process.env['USERPROFILE'];
const originalXdg = process.env['XDG_CONFIG_HOME'];
let tempHome = '';

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-codex-provider-'));
  process.env['HOME'] = tempHome;
  process.env['USERPROFILE'] = tempHome;
  process.env['XDG_CONFIG_HOME'] = tempHome;
});

afterEach(async () => {
  if (typeof originalHome === 'string') {
    process.env['HOME'] = originalHome;
  } else {
    delete process.env['HOME'];
  }

  if (typeof originalUserProfile === 'string') {
    process.env['USERPROFILE'] = originalUserProfile;
  } else {
    delete process.env['USERPROFILE'];
  }

  if (typeof originalXdg === 'string') {
    process.env['XDG_CONFIG_HOME'] = originalXdg;
  } else {
    delete process.env['XDG_CONFIG_HOME'];
  }

  if (tempHome) {
    await fs.rm(tempHome, { recursive: true, force: true });
    tempHome = '';
  }
});

async function withAllowedCommands(
  commands: string[],
  run: () => Promise<void>
): Promise<void> {
  const configHome = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-allowed-commands-'));
  const previousXdg = process.env['XDG_CONFIG_HOME'];
  const previousHome = process.env['HOME'];
  const previousUserProfile = process.env['USERPROFILE'];

  process.env['HOME'] = configHome;
  process.env['USERPROFILE'] = configHome;
  process.env['XDG_CONFIG_HOME'] = configHome;

  try {
    const registryPath = path.join(configHome, '.keygate', 'allowed_commands.json');
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(
      registryPath,
      `${JSON.stringify({ version: 1, commands }, null, 2)}\n`,
      'utf8'
    );
    await run();
  } finally {
    if (typeof previousXdg === 'string') {
      process.env['XDG_CONFIG_HOME'] = previousXdg;
    } else {
      delete process.env['XDG_CONFIG_HOME'];
    }

    if (typeof previousHome === 'string') {
      process.env['HOME'] = previousHome;
    } else {
      delete process.env['HOME'];
    }

    if (typeof previousUserProfile === 'string') {
      process.env['USERPROFILE'] = previousUserProfile;
    } else {
      delete process.env['USERPROFILE'];
    }
    await fs.rm(configHome, { recursive: true, force: true });
  }
}

describe('OpenAICodexProvider', () => {
  it('prints auth URL in headless codex login flow without trying to open browser', async () => {
    const fake = new FakeChildProcess();
    const openExternalUrl = vi.fn(async () => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    fake.stdin.on('data', (chunk) => {
      const lines = String(chunk)
        .split(/\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        const payload = JSON.parse(line) as {
          id?: number;
          method: string;
          params?: Record<string, unknown>;
        };

        if (payload.method === 'initialized') {
          continue;
        }

        if (payload.method === 'initialize') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: { sessionId: 'session-login' },
          }) + '\n');
          continue;
        }

        if (payload.method === 'account/read') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: { account: null, requiresOpenaiAuth: true },
          }) + '\n');
          continue;
        }

        if (payload.method === 'account/login/start') {
          const loginId = 'login-1';
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: { loginId, authUrl: 'https://example.test/login' },
          }) + '\n');

          setTimeout(() => {
            fake.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              method: 'account/login/completed',
              params: { loginId, success: true },
            }) + '\n');
          }, 0);
          continue;
        }
      }
    });

    const rpcClient = new CodexRpcClient({
      requestTimeoutMs: 5_000,
      spawnFactory: () => fake as any,
    });

    const provider = new OpenAICodexProvider('openai-codex/gpt-5.3', {
      rpcClient,
      openExternalUrl,
      loginTimeoutMs: 5_000,
    });

    try {
      await provider.login({ headless: true, timeoutMs: 5_000 });
      expect(openExternalUrl).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith('Open this URL to sign in:\nhttps://example.test/login');
    } finally {
      logSpy.mockRestore();
      await provider.dispose();
    }
  });

  it('parses model/list entries correctly', async () => {
    const fake = new FakeChildProcess();

    fake.stdin.on('data', (chunk) => {
      const lines = String(chunk)
        .split(/\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        const payload = JSON.parse(line) as {
          id?: number;
          method: string;
          params?: Record<string, unknown>;
        };

        if (payload.method === 'initialized') {
          continue;
        }

        if (payload.method === 'initialize') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: { sessionId: 'session-1' },
          }) + '\n');
          continue;
        }

        if (payload.method === 'model/list') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: {
              data: [
                {
                  id: 'gpt-5.2-codex',
                  displayName: 'GPT-5.2 Codex',
                  isDefault: true,
                  supportsPersonality: true,
                },
                {
                  id: 'gpt-5-codex',
                  displayName: 'GPT-5 Codex',
                  isDefault: false,
                },
              ],
              nextCursor: null,
            },
          }) + '\n');
          continue;
        }
      }
    });

    const rpcClient = new CodexRpcClient({
      requestTimeoutMs: 5_000,
      spawnFactory: () => fake as any,
    });

    const provider = new OpenAICodexProvider('openai-codex/gpt-5.2', {
      rpcClient,
      loginTimeoutMs: 5_000,
    });

    const models = await provider.listModels();

    expect(models.map((model) => model.id)).toEqual([
      'openai-codex/gpt-5.3',
      'openai-codex/gpt-5.2',
    ]);
    expect(models[0]?.isDefault).toBe(true);
    expect(models[0]?.reasoningEffort).toEqual(['low', 'medium', 'high', 'xhigh']);

    await provider.dispose();
  });

  it('sends turn/start sandboxPolicy with required mode field', async () => {
    const fake = new FakeChildProcess();
    let observedSandboxPolicy: Record<string, unknown> | undefined;
    let observedThreadApprovalPolicy: string | undefined;
    let observedThreadSandbox: string | undefined;
    let observedTurnApprovalPolicy: string | undefined;
    let observedTurnInputText = '';

    fake.stdin.on('data', (chunk) => {
      const lines = String(chunk)
        .split(/\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        const payload = JSON.parse(line) as {
          id?: number;
          method: string;
          params?: Record<string, unknown>;
        };

        if (payload.method === 'initialized') {
          continue;
        }

        if (payload.method === 'initialize') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: { sessionId: 'session-1' },
          }) + '\n');
          continue;
        }

        if (payload.method === 'thread/start') {
          observedThreadApprovalPolicy = payload.params?.['approvalPolicy'] as string | undefined;
          observedThreadSandbox = payload.params?.['sandbox'] as string | undefined;
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: {
              thread: { id: 'thread-1' },
            },
          }) + '\n');
          continue;
        }

        if (payload.method === 'model/list') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: {
              data: [
                { id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', isDefault: true },
              ],
              nextCursor: null,
            },
          }) + '\n');
          continue;
        }

        if (payload.method === 'turn/start') {
          observedSandboxPolicy = payload.params?.['sandboxPolicy'] as Record<string, unknown> | undefined;
          observedTurnApprovalPolicy = payload.params?.['approvalPolicy'] as string | undefined;
          const input = payload.params?.['input'];
          if (Array.isArray(input)) {
            const first = input[0];
            if (first && typeof first === 'object') {
              const text = (first as Record<string, unknown>)['text'];
              if (typeof text === 'string') {
                observedTurnInputText = text;
              }
            }
          }

          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: {
              turn: { id: 'turn-1' },
            },
          }) + '\n');

          setTimeout(() => {
            fake.stdout.write(JSON.stringify({
              method: 'turn/completed',
              params: {
                threadId: 'thread-1',
                turn: {
                  id: 'turn-1',
                  status: 'completed',
                },
              },
            }) + '\n');
          }, 5);
          continue;
        }
      }
    });

    const rpcClient = new CodexRpcClient({
      requestTimeoutMs: 5_000,
      spawnFactory: () => fake as any,
    });

    const provider = new OpenAICodexProvider('openai-codex/gpt-5.2', {
      rpcClient,
    });

    const stream = provider.stream(
      [
        { role: 'system', content: 'Bootstrap rules here' },
        { role: 'user', content: 'hello codex' },
      ],
      {
        sessionId: 'session-abc',
        securityMode: 'safe',
        cwd: '/tmp/keygate-tests',
      }
    );

    for await (const _chunk of stream) {
      // Drain stream until completion.
    }

    expect(observedSandboxPolicy?.['type']).toBe('workspaceWrite');
    expect(observedSandboxPolicy?.['writable_roots']).toEqual(['/tmp/keygate-tests']);
    expect(observedSandboxPolicy?.['network_access']).toBe(true);
    expect(observedThreadApprovalPolicy).toBe('untrusted');
    expect(observedThreadSandbox).toBe('workspace-write');
    expect(observedTurnApprovalPolicy).toBe('untrusted');
    expect(observedTurnInputText).toContain('SYSTEM INSTRUCTIONS');
    expect(observedTurnInputText).toContain('Bootstrap rules here');
    expect(observedTurnInputText).toContain('USER MESSAGE:');
    expect(observedTurnInputText).toContain('hello codex');
    expect(observedTurnInputText).toContain('MODEL IDENTITY (KEYGATE PROJECT): You are Keygate\'s AI assistant.');
    expect(observedTurnInputText).toContain('browser_snapshot');
    expect(observedTurnInputText).toContain('browser_take_screenshot');
    expect(observedTurnInputText).toContain('session-session-abc-step-<n>.png');
    expect(observedTurnInputText).toContain('SAFE MODE: Before mutating browser actions, ask for explicit user confirmation in chat');

    await provider.dispose();
  });

  it('does not duplicate completed agent text after streamed delta', async () => {
    const fake = new FakeChildProcess();

    fake.stdin.on('data', (chunk) => {
      const lines = String(chunk)
        .split(/\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        const payload = JSON.parse(line) as {
          id?: number;
          method: string;
          params?: Record<string, unknown>;
        };

        if (payload.method === 'initialized') {
          continue;
        }

        if (payload.method === 'initialize') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: { sessionId: 'session-1' },
          }) + '\n');
          continue;
        }

        if (payload.method === 'model/list') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: {
              data: [
                { id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', isDefault: true },
              ],
              nextCursor: null,
            },
          }) + '\n');
          continue;
        }

        if (payload.method === 'thread/start') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: {
              thread: { id: 'thread-1' },
            },
          }) + '\n');
          continue;
        }

        if (payload.method === 'turn/start') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: {
              turn: { id: 'turn-1' },
            },
          }) + '\n');

          setTimeout(() => {
            fake.stdout.write(JSON.stringify({
              method: 'item/agentMessage/delta',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                delta: 'Hello.',
              },
            }) + '\n');

            fake.stdout.write(JSON.stringify({
              method: 'item/completed',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: {
                  type: 'agentMessage',
                  text: 'Hello.',
                },
              },
            }) + '\n');

            fake.stdout.write(JSON.stringify({
              method: 'turn/completed',
              params: {
                threadId: 'thread-1',
                turn: {
                  id: 'turn-1',
                  status: 'completed',
                },
              },
            }) + '\n');
          }, 5);
          continue;
        }
      }
    });

    const rpcClient = new CodexRpcClient({
      requestTimeoutMs: 5_000,
      spawnFactory: () => fake as any,
    });

    const provider = new OpenAICodexProvider('openai-codex/gpt-5.2', {
      rpcClient,
    });

    let text = '';
    for await (const chunk of provider.stream(
      [{ role: 'user', content: 'hello codex' }],
      {
        sessionId: 'session-dup-test',
      }
    )) {
      if (chunk.content) {
        text += chunk.content;
      }
    }

    expect(text).toBe('Hello.');

    await provider.dispose();
  });

  it('continues turn after server approval request is answered', async () => {
    const fake = new FakeChildProcess();
    let approvalResponseSeen = false;

    fake.stdin.on('data', (chunk) => {
      const lines = String(chunk)
        .split(/\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        const payload = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
          result?: { decision?: string };
        };

        if (payload.method === 'initialized') {
          continue;
        }

        if (payload.method === 'initialize') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: { sessionId: 'session-1' },
          }) + '\n');
          continue;
        }

        if (payload.method === 'model/list') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: {
              data: [
                { id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', isDefault: true },
              ],
              nextCursor: null,
            },
          }) + '\n');
          continue;
        }

        if (payload.method === 'thread/start') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: {
              thread: { id: 'thread-1' },
            },
          }) + '\n');
          continue;
        }

        if (payload.method === 'turn/start') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: {
              turn: { id: 'turn-1' },
            },
          }) + '\n');

          setTimeout(() => {
            fake.stdout.write(JSON.stringify({
              id: 9001,
              method: 'execCommandApproval',
              params: {
                conversationId: 'conv-1',
                callId: 'call-1',
                command: ['echo', 'hello'],
                cwd: '/tmp',
                reason: null,
                risk: null,
                parsedCmd: [],
              },
            }) + '\n');
          }, 5);
          continue;
        }

        if (payload.id === 9001 && payload.result?.decision === 'approved') {
          approvalResponseSeen = true;
          fake.stdout.write(JSON.stringify({
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: {
                id: 'turn-1',
                status: 'completed',
              },
            },
          }) + '\n');
        }
      }
    });

    const rpcClient = new CodexRpcClient({
      requestTimeoutMs: 5_000,
      spawnFactory: () => fake as any,
    });

    const provider = new OpenAICodexProvider('openai-codex/gpt-5.2', {
      rpcClient,
    });

    for await (const _chunk of provider.stream(
      [{ role: 'user', content: 'hello codex' }],
      { sessionId: 'session-approval-test' }
    )) {
      // drain stream to completion
    }

    expect(approvalResponseSeen).toBe(true);

    await provider.dispose();
  });

  it('forwards codex approval requests to requestConfirmation callback', async () => {
    const fake = new FakeChildProcess();
    const requestConfirmation = vi.fn(async () => 'allow_once' as const);

    fake.stdin.on('data', (chunk) => {
      const lines = String(chunk)
        .split(/\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        const payload = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
          result?: { decision?: string };
        };

        if (payload.method === 'initialized') {
          continue;
        }

        if (payload.method === 'initialize') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { sessionId: 'session-1' } }) + '\n');
          continue;
        }

        if (payload.method === 'model/list') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: { data: [{ id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', isDefault: true }], nextCursor: null },
          }) + '\n');
          continue;
        }

        if (payload.method === 'thread/start') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { thread: { id: 'thread-1' } } }) + '\n');
          continue;
        }

        if (payload.method === 'turn/start') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { turn: { id: 'turn-1' } } }) + '\n');

          setTimeout(() => {
            fake.stdout.write(JSON.stringify({
              id: 321,
              method: 'execCommandApproval',
              params: {
                conversationId: 'conv-1',
                callId: 'call-1',
                command: ['echo', 'hello'],
                cwd: '/tmp',
                reason: null,
                risk: null,
                parsedCmd: [],
              },
            }) + '\n');
          }, 5);
          continue;
        }

        if (payload.id === 321) {
          fake.stdout.write(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
          }) + '\n');
        }
      }
    });

    const rpcClient = new CodexRpcClient({
      requestTimeoutMs: 5_000,
      spawnFactory: () => fake as any,
    });

    const provider = new OpenAICodexProvider('openai-codex/gpt-5.2', { rpcClient });

    for await (const _chunk of provider.stream(
      [{ role: 'user', content: 'hello codex' }],
      { sessionId: 'session-forward-approval', requestConfirmation }
    )) {
      // drain stream
    }

    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(requestConfirmation.mock.calls[0]?.[0]).toMatchObject({
      tool: 'codex.exec',
      action: 'command execution',
    });

    await provider.dispose();
  });

  it('still prompts when wrapper commands are present in global allowlist', async () => {
    await withAllowedCommands(['bash'], async () => {
      const fake = new FakeChildProcess();
      const requestConfirmation = vi.fn(async () => 'allow_once' as const);
      let approvalDecision: string | undefined;

      fake.stdin.on('data', (chunk) => {
        const lines = String(chunk)
          .split(/\n/g)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);

        for (const line of lines) {
          const payload = JSON.parse(line) as {
            id?: number | string;
            method?: string;
            result?: { decision?: string };
          };

          if (payload.method === 'initialized') {
            continue;
          }

          if (payload.method === 'initialize') {
            fake.stdout.write(JSON.stringify({ id: payload.id, result: { sessionId: 'session-1' } }) + '\n');
            continue;
          }

          if (payload.method === 'model/list') {
            fake.stdout.write(JSON.stringify({
              id: payload.id,
              result: { data: [{ id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', isDefault: true }], nextCursor: null },
            }) + '\n');
            continue;
          }

          if (payload.method === 'thread/start') {
            fake.stdout.write(JSON.stringify({ id: payload.id, result: { thread: { id: 'thread-1' } } }) + '\n');
            continue;
          }

          if (payload.method === 'turn/start') {
            fake.stdout.write(JSON.stringify({ id: payload.id, result: { turn: { id: 'turn-1' } } }) + '\n');

            setTimeout(() => {
              fake.stdout.write(JSON.stringify({
                id: 'wrapper-approval-1',
                method: 'execCommandApproval',
                params: {
                  conversationId: 'conv-1',
                  callId: 'call-1',
                  command: ['bash', '-lc', 'echo hello'],
                  cwd: '/tmp',
                  reason: null,
                  risk: null,
                  parsedCmd: [],
                },
              }) + '\n');
            }, 5);
            continue;
          }

          if (payload.id === 'wrapper-approval-1') {
            approvalDecision = payload.result?.decision;
            fake.stdout.write(JSON.stringify({
              method: 'turn/completed',
              params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
            }) + '\n');
          }
        }
      });

      const rpcClient = new CodexRpcClient({
        requestTimeoutMs: 5_000,
        spawnFactory: () => fake as any,
      });

      const provider = new OpenAICodexProvider('openai-codex/gpt-5.2', { rpcClient });
      try {
        for await (const _chunk of provider.stream(
          [{ role: 'user', content: 'hello codex' }],
          { sessionId: 'session-wrapper-global-allow', requestConfirmation }
        )) {
          // drain stream
        }
      } finally {
        await provider.dispose();
      }

      expect(requestConfirmation).toHaveBeenCalledTimes(1);
      expect(approvalDecision).toBe('approved');
    });
  });

  it('honors global allowlist even when Codex includes an escalation reason', async () => {
    await withAllowedCommands(['echo'], async () => {
      const fake = new FakeChildProcess();
      const requestConfirmation = vi.fn(async () => 'allow_once' as const);
      let approvalDecision: string | undefined;

      fake.stdin.on('data', (chunk) => {
        const lines = String(chunk)
          .split(/\n/g)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);

        for (const line of lines) {
          const payload = JSON.parse(line) as {
            id?: number | string;
            method?: string;
            result?: { decision?: string };
          };

          if (payload.method === 'initialized') {
            continue;
          }

          if (payload.method === 'initialize') {
            fake.stdout.write(JSON.stringify({ id: payload.id, result: { sessionId: 'session-1' } }) + '\n');
            continue;
          }

          if (payload.method === 'model/list') {
            fake.stdout.write(JSON.stringify({
              id: payload.id,
              result: { data: [{ id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', isDefault: true }], nextCursor: null },
            }) + '\n');
            continue;
          }

          if (payload.method === 'thread/start') {
            fake.stdout.write(JSON.stringify({ id: payload.id, result: { thread: { id: 'thread-1' } } }) + '\n');
            continue;
          }

          if (payload.method === 'turn/start') {
            fake.stdout.write(JSON.stringify({ id: payload.id, result: { turn: { id: 'turn-1' } } }) + '\n');

            setTimeout(() => {
              fake.stdout.write(JSON.stringify({
                id: 'reason-approval-1',
                method: 'execCommandApproval',
                params: {
                  conversationId: 'conv-1',
                  callId: 'call-1',
                  command: ['echo', 'hello'],
                  cwd: '/tmp',
                  reason: 'Codex requested an approval outside workspace sandbox.',
                  risk: null,
                  parsedCmd: [],
                },
              }) + '\n');
            }, 5);
            continue;
          }

          if (payload.id === 'reason-approval-1') {
            approvalDecision = payload.result?.decision;
            fake.stdout.write(JSON.stringify({
              method: 'turn/completed',
              params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
            }) + '\n');
          }
        }
      });

      const rpcClient = new CodexRpcClient({
        requestTimeoutMs: 5_000,
        spawnFactory: () => fake as any,
      });

      const provider = new OpenAICodexProvider('openai-codex/gpt-5.2', { rpcClient });
      try {
        for await (const _chunk of provider.stream(
          [{ role: 'user', content: 'hello codex' }],
          { sessionId: 'session-reason-global-allow', requestConfirmation }
        )) {
          // drain stream
        }
      } finally {
        await provider.dispose();
      }

      expect(requestConfirmation).not.toHaveBeenCalled();
      expect(approvalDecision).toBe('approved');
    });
  });

  it('forwards codex approval requests with string ids to requestConfirmation callback', async () => {
    const fake = new FakeChildProcess();
    const requestConfirmation = vi.fn(async () => 'allow_once' as const);
    let approvalResponseId: number | string | undefined;

    fake.stdin.on('data', (chunk) => {
      const lines = String(chunk)
        .split(/\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        const payload = JSON.parse(line) as {
          id?: number | string;
          method?: string;
          params?: Record<string, unknown>;
          result?: { decision?: string };
        };

        if (payload.method === 'initialized') {
          continue;
        }

        if (payload.method === 'initialize') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { sessionId: 'session-1' } }) + '\n');
          continue;
        }

        if (payload.method === 'model/list') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: { data: [{ id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', isDefault: true }], nextCursor: null },
          }) + '\n');
          continue;
        }

        if (payload.method === 'thread/start') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { thread: { id: 'thread-1' } } }) + '\n');
          continue;
        }

        if (payload.method === 'turn/start') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { turn: { id: 'turn-1' } } }) + '\n');

          setTimeout(() => {
            fake.stdout.write(JSON.stringify({
              id: 'approval-321',
              method: 'execCommandApproval',
              params: {
                conversationId: 'conv-1',
                callId: 'call-1',
                command: ['echo', 'hello'],
                cwd: '/tmp',
                reason: null,
                risk: null,
                parsedCmd: [],
              },
            }) + '\n');
          }, 5);
          continue;
        }

        if (payload.id === 'approval-321') {
          approvalResponseId = payload.id;
          fake.stdout.write(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
          }) + '\n');
        }
      }
    });

    const rpcClient = new CodexRpcClient({
      requestTimeoutMs: 5_000,
      spawnFactory: () => fake as any,
    });

    const provider = new OpenAICodexProvider('openai-codex/gpt-5.2', { rpcClient });

    for await (const _chunk of provider.stream(
      [{ role: 'user', content: 'hello codex' }],
      { sessionId: 'session-forward-approval-string-id', requestConfirmation }
    )) {
      // drain stream
    }

    expect(approvalResponseId).toBe('approval-321');
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(requestConfirmation.mock.calls[0]?.[0]).toMatchObject({
      tool: 'codex.exec',
      action: 'command execution',
    });

    await provider.dispose();
  });

  it('forwards approval method variants to requestConfirmation callback', async () => {
    const fake = new FakeChildProcess();
    const requestConfirmation = vi.fn(async () => 'allow_once' as const);

    fake.stdin.on('data', (chunk) => {
      const lines = String(chunk)
        .split(/\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        const payload = JSON.parse(line) as {
          id?: number | string;
          method?: string;
          result?: { decision?: string };
        };

        if (payload.method === 'initialized') {
          continue;
        }

        if (payload.method === 'initialize') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { sessionId: 'session-1' } }) + '\n');
          continue;
        }

        if (payload.method === 'model/list') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: { data: [{ id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', isDefault: true }], nextCursor: null },
          }) + '\n');
          continue;
        }

        if (payload.method === 'thread/start') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { thread: { id: 'thread-1' } } }) + '\n');
          continue;
        }

        if (payload.method === 'turn/start') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { turn: { id: 'turn-1' } } }) + '\n');

          setTimeout(() => {
            fake.stdout.write(JSON.stringify({
              id: 'approval-variant-1',
              method: 'patch_apply_approval',
              params: {
                call_id: 'call-1',
              },
            }) + '\n');
          }, 5);
          continue;
        }

        if (payload.id === 'approval-variant-1') {
          fake.stdout.write(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
          }) + '\n');
        }
      }
    });

    const rpcClient = new CodexRpcClient({
      requestTimeoutMs: 5_000,
      spawnFactory: () => fake as any,
    });

    const provider = new OpenAICodexProvider('openai-codex/gpt-5.2', { rpcClient });

    for await (const _chunk of provider.stream(
      [{ role: 'user', content: 'hello codex' }],
      { sessionId: 'session-forward-approval-variant', requestConfirmation }
    )) {
      // drain stream
    }

    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(requestConfirmation.mock.calls[0]?.[0]).toMatchObject({
      tool: 'codex.apply_patch',
      action: 'patch apply',
    });

    await provider.dispose();
  });

  it('maps allow_always to approved and reuses it for repeated patch approvals', async () => {
    const fake = new FakeChildProcess();
    const requestConfirmation = vi.fn(async () => 'allow_always' as const);
    let firstDecision: string | undefined;
    let secondDecision: string | undefined;

    fake.stdin.on('data', (chunk) => {
      const lines = String(chunk)
        .split(/\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        const payload = JSON.parse(line) as {
          id?: number | string;
          method?: string;
          result?: { decision?: string };
        };

        if (payload.method === 'initialized') {
          continue;
        }

        if (payload.method === 'initialize') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { sessionId: 'session-1' } }) + '\n');
          continue;
        }

        if (payload.method === 'model/list') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: { data: [{ id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', isDefault: true }], nextCursor: null },
          }) + '\n');
          continue;
        }

        if (payload.method === 'thread/start') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { thread: { id: 'thread-1' } } }) + '\n');
          continue;
        }

        if (payload.method === 'turn/start') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { turn: { id: 'turn-1' } } }) + '\n');

          setTimeout(() => {
            fake.stdout.write(JSON.stringify({
              id: 'patch-approval-1',
              method: 'patch_apply_approval',
              params: { call_id: 'call-1' },
            }) + '\n');
          }, 5);
          continue;
        }

        if (payload.id === 'patch-approval-1') {
          firstDecision = payload.result?.decision;
          fake.stdout.write(JSON.stringify({
            id: 'patch-approval-2',
            method: 'patch_apply_approval',
            params: { call_id: 'call-2' },
          }) + '\n');
          continue;
        }

        if (payload.id === 'patch-approval-2') {
          secondDecision = payload.result?.decision;
          fake.stdout.write(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
          }) + '\n');
        }
      }
    });

    const rpcClient = new CodexRpcClient({
      requestTimeoutMs: 5_000,
      spawnFactory: () => fake as any,
    });

    const provider = new OpenAICodexProvider('openai-codex/gpt-5.2', { rpcClient });

    for await (const _chunk of provider.stream(
      [{ role: 'user', content: 'hello codex' }],
      { sessionId: 'session-allow-always-patch', requestConfirmation }
    )) {
      // drain stream
    }

    expect(firstDecision).toBe('approved_for_session');
    expect(secondDecision).toBe('approved_for_session');
    expect(requestConfirmation).toHaveBeenCalledTimes(1);

    await provider.dispose();
  });

  it('maps allow_always to acceptForSession for item requestApproval methods', async () => {
    const fake = new FakeChildProcess();
    const requestConfirmation = vi.fn(async () => 'allow_always' as const);
    let firstDecision: string | undefined;
    let secondDecision: string | undefined;

    fake.stdin.on('data', (chunk) => {
      const lines = String(chunk)
        .split(/\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        const payload = JSON.parse(line) as {
          id?: number | string;
          method?: string;
          result?: { decision?: string };
        };

        if (payload.method === 'initialized') {
          continue;
        }

        if (payload.method === 'initialize') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { sessionId: 'session-1' } }) + '\n');
          continue;
        }

        if (payload.method === 'model/list') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: { data: [{ id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', isDefault: true }], nextCursor: null },
          }) + '\n');
          continue;
        }

        if (payload.method === 'thread/start') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { thread: { id: 'thread-1' } } }) + '\n');
          continue;
        }

        if (payload.method === 'turn/start') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { turn: { id: 'turn-1' } } }) + '\n');

          setTimeout(() => {
            fake.stdout.write(JSON.stringify({
              id: 'filechange-approval-1',
              method: 'item/fileChange/requestApproval',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                itemId: 'call-1',
                reason: null,
                grantRoot: null,
              },
            }) + '\n');
          }, 5);
          continue;
        }

        if (payload.id === 'filechange-approval-1') {
          firstDecision = payload.result?.decision;
          fake.stdout.write(JSON.stringify({
            id: 'filechange-approval-2',
            method: 'item/fileChange/requestApproval',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'call-2',
              reason: null,
              grantRoot: null,
            },
          }) + '\n');
          continue;
        }

        if (payload.id === 'filechange-approval-2') {
          secondDecision = payload.result?.decision;
          fake.stdout.write(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
          }) + '\n');
        }
      }
    });

    const rpcClient = new CodexRpcClient({
      requestTimeoutMs: 5_000,
      spawnFactory: () => fake as any,
    });

    const provider = new OpenAICodexProvider('openai-codex/gpt-5.2', { rpcClient });

    for await (const _chunk of provider.stream(
      [{ role: 'user', content: 'hello codex' }],
      { sessionId: 'session-allow-always-item-approval', requestConfirmation }
    )) {
      // drain stream
    }

    expect(firstDecision).toBe('acceptForSession');
    expect(secondDecision).toBe('acceptForSession');
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(requestConfirmation.mock.calls[0]?.[0]).toMatchObject({
      tool: 'codex.apply_patch',
      action: 'patch apply',
    });

    await provider.dispose();
  });

  it('dedupes cumulative delta payloads from codex notifications', async () => {
    const fake = new FakeChildProcess();

    fake.stdin.on('data', (chunk) => {
      const lines = String(chunk)
        .split(/\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        const payload = JSON.parse(line) as {
          id?: number;
          method: string;
        };

        if (payload.method === 'initialized') {
          continue;
        }

        if (payload.method === 'initialize') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { sessionId: 'session-1' } }) + '\n');
          continue;
        }

        if (payload.method === 'model/list') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: { data: [{ id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', isDefault: true }], nextCursor: null },
          }) + '\n');
          continue;
        }

        if (payload.method === 'thread/start') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { thread: { id: 'thread-1' } } }) + '\n');
          continue;
        }

        if (payload.method === 'turn/start') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { turn: { id: 'turn-1' } } }) + '\n');

          setTimeout(() => {
            fake.stdout.write(JSON.stringify({
              method: 'item/agentMessage/delta',
              params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'Hello' },
            }) + '\n');
            fake.stdout.write(JSON.stringify({
              method: 'item/agentMessage/delta',
              params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'Hello world' },
            }) + '\n');
            fake.stdout.write(JSON.stringify({
              method: 'item/completed',
              params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', text: 'Hello world' } },
            }) + '\n');
            fake.stdout.write(JSON.stringify({
              method: 'turn/completed',
              params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
            }) + '\n');
          }, 5);
          continue;
        }
      }
    });

    const rpcClient = new CodexRpcClient({
      requestTimeoutMs: 5_000,
      spawnFactory: () => fake as any,
    });

    const provider = new OpenAICodexProvider('openai-codex/gpt-5.2', { rpcClient });

    let text = '';
    for await (const chunk of provider.stream(
      [{ role: 'user', content: 'hello codex' }],
      { sessionId: 'session-cumulative-delta' }
    )) {
      if (chunk.content) {
        text += chunk.content;
      }
    }

    expect(text).toBe('Hello world');
    await provider.dispose();
  });

  it('does not inject newlines for incremental token deltas', async () => {
    const fake = new FakeChildProcess();

    fake.stdin.on('data', (chunk) => {
      const lines = String(chunk)
        .split(/\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        const payload = JSON.parse(line) as {
          id?: number;
          method: string;
        };

        if (payload.method === 'initialized') {
          continue;
        }

        if (payload.method === 'initialize') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { sessionId: 'session-1' } }) + '\n');
          continue;
        }

        if (payload.method === 'model/list') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: { data: [{ id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', isDefault: true }], nextCursor: null },
          }) + '\n');
          continue;
        }

        if (payload.method === 'thread/start') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { thread: { id: 'thread-1' } } }) + '\n');
          continue;
        }

        if (payload.method === 'turn/start') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { turn: { id: 'turn-1' } } }) + '\n');

          setTimeout(() => {
            const deltas = ['Hey', '.', ' I', ' just', ' came', ' online', '.'];
            for (const delta of deltas) {
              fake.stdout.write(JSON.stringify({
                method: 'item/agentMessage/delta',
                params: { threadId: 'thread-1', turnId: 'turn-1', delta },
              }) + '\n');
            }

            fake.stdout.write(JSON.stringify({
              method: 'turn/completed',
              params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
            }) + '\n');
          }, 5);
          continue;
        }
      }
    });

    const rpcClient = new CodexRpcClient({
      requestTimeoutMs: 5_000,
      spawnFactory: () => fake as any,
    });

    const provider = new OpenAICodexProvider('openai-codex/gpt-5.2', { rpcClient });

    let text = '';
    for await (const chunk of provider.stream(
      [{ role: 'user', content: 'hello codex' }],
      { sessionId: 'session-token-delta' }
    )) {
      if (chunk.content) {
        text += chunk.content;
      }
    }

    expect(text).toBe('Hey. I just came online.');
    expect(text).not.toContain('\n');
    await provider.dispose();
  });

  it('flattens single-leading-newline token deltas into normal inline text', async () => {
    const fake = new FakeChildProcess();

    fake.stdin.on('data', (chunk) => {
      const lines = String(chunk)
        .split(/\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        const payload = JSON.parse(line) as {
          id?: number;
          method: string;
        };

        if (payload.method === 'initialized') {
          continue;
        }

        if (payload.method === 'initialize') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { sessionId: 'session-1' } }) + '\n');
          continue;
        }

        if (payload.method === 'model/list') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: { data: [{ id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', isDefault: true }], nextCursor: null },
          }) + '\n');
          continue;
        }

        if (payload.method === 'thread/start') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { thread: { id: 'thread-1' } } }) + '\n');
          continue;
        }

        if (payload.method === 'turn/start') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { turn: { id: 'turn-1' } } }) + '\n');

          setTimeout(() => {
            const deltas = ['Hey', '\n.', '\n I', '\n just', '\n came', '\n online', '\n?'];
            for (const delta of deltas) {
              fake.stdout.write(JSON.stringify({
                method: 'item/agentMessage/delta',
                params: { threadId: 'thread-1', turnId: 'turn-1', delta },
              }) + '\n');
            }

            fake.stdout.write(JSON.stringify({
              method: 'item/completed',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: {
                  type: 'agentMessage',
                  text: 'Hey. I just came online?',
                },
              },
            }) + '\n');

            fake.stdout.write(JSON.stringify({
              method: 'turn/completed',
              params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
            }) + '\n');
          }, 5);
          continue;
        }
      }
    });

    const rpcClient = new CodexRpcClient({
      requestTimeoutMs: 5_000,
      spawnFactory: () => fake as any,
    });

    const provider = new OpenAICodexProvider('openai-codex/gpt-5.2', { rpcClient });

    let text = '';
    for await (const chunk of provider.stream(
      [{ role: 'user', content: 'hello codex' }],
      { sessionId: 'session-leading-newline-token' }
    )) {
      if (chunk.content) {
        text += chunk.content;
      }
    }

    expect(text).toBe('Hey. I just came online?');
    expect(text).not.toContain('\n');
    await provider.dispose();
  });

  it('flattens token deltas that arrive with trailing newlines', async () => {
    const fake = new FakeChildProcess();

    fake.stdin.on('data', (chunk) => {
      const lines = String(chunk)
        .split(/\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        const payload = JSON.parse(line) as {
          id?: number;
          method: string;
        };

        if (payload.method === 'initialized') {
          continue;
        }

        if (payload.method === 'initialize') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { sessionId: 'session-1' } }) + '\n');
          continue;
        }

        if (payload.method === 'model/list') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: { data: [{ id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', isDefault: true }], nextCursor: null },
          }) + '\n');
          continue;
        }

        if (payload.method === 'thread/start') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { thread: { id: 'thread-1' } } }) + '\n');
          continue;
        }

        if (payload.method === 'turn/start') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { turn: { id: 'turn-1' } } }) + '\n');

          setTimeout(() => {
            const deltas = ['Hey\n', '.\n', ' I\n', ' just\n', ' came\n', ' online\n', '?\n'];
            for (const delta of deltas) {
              fake.stdout.write(JSON.stringify({
                method: 'item/agentMessage/delta',
                params: { threadId: 'thread-1', turnId: 'turn-1', delta },
              }) + '\n');
            }

            fake.stdout.write(JSON.stringify({
              method: 'item/completed',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: {
                  type: 'agentMessage',
                  text: 'Hey. I just came online?',
                },
              },
            }) + '\n');

            fake.stdout.write(JSON.stringify({
              method: 'turn/completed',
              params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
            }) + '\n');
          }, 5);
          continue;
        }
      }
    });

    const rpcClient = new CodexRpcClient({
      requestTimeoutMs: 5_000,
      spawnFactory: () => fake as any,
    });

    const provider = new OpenAICodexProvider('openai-codex/gpt-5.2', { rpcClient });

    let text = '';
    for await (const chunk of provider.stream(
      [{ role: 'user', content: 'hello codex' }],
      { sessionId: 'session-trailing-newline-token' }
    )) {
      if (chunk.content) {
        text += chunk.content;
      }
    }

    expect(text).toBe('Hey. I just came online?');
    expect(text).not.toContain('\n');
    await provider.dispose();
  });

  it('includes localImage items in turn/start input when latest user message has attachments', async () => {
    const fake = new FakeChildProcess();
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-codex-localimage-'));
    const imagePath = path.join(fixtureRoot, 'photo.png');
    await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    let observedInput: Array<Record<string, unknown>> = [];

    fake.stdin.on('data', (chunk) => {
      const lines = String(chunk)
        .split(/\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        const payload = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
        };

        if (payload.method === 'initialized') {
          continue;
        }

        if (payload.method === 'initialize') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { sessionId: 'session-1' } }) + '\n');
          continue;
        }

        if (payload.method === 'model/list') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: { data: [{ id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', isDefault: true }], nextCursor: null },
          }) + '\n');
          continue;
        }

        if (payload.method === 'thread/start') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { thread: { id: 'thread-1' } } }) + '\n');
          continue;
        }

        if (payload.method === 'turn/start') {
          observedInput = Array.isArray(payload.params?.['input'])
            ? payload.params?.['input'] as Array<Record<string, unknown>>
            : [];

          fake.stdout.write(JSON.stringify({ id: payload.id, result: { turn: { id: 'turn-1' } } }) + '\n');
          setTimeout(() => {
            fake.stdout.write(JSON.stringify({
              method: 'turn/completed',
              params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
            }) + '\n');
          }, 5);
          continue;
        }
      }
    });

    const rpcClient = new CodexRpcClient({
      requestTimeoutMs: 5_000,
      spawnFactory: () => fake as any,
    });
    const provider = new OpenAICodexProvider('openai-codex/gpt-5.2', { rpcClient });

    for await (const _chunk of provider.stream(
      [{
        role: 'user',
        content: 'analyze',
        attachments: [{
          id: 'att-1',
          filename: 'photo.png',
          contentType: 'image/png',
          sizeBytes: 4,
          path: imagePath,
          url: '/api/uploads/image?sessionId=web%3Atest&id=att-1',
        }],
      }],
      { sessionId: 'session-local-image' }
    )) {
      // drain
    }

    expect(observedInput[0]).toMatchObject({ type: 'text' });
    expect(observedInput[1]).toEqual({
      type: 'localImage',
      path: imagePath,
    });

    await provider.dispose();
  });

  it('retries turn/start once with data-url image items when localImage is rejected', async () => {
    const fake = new FakeChildProcess();
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-codex-fallback-'));
    const imagePath = path.join(fixtureRoot, 'photo.png');
    await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const observedInputs: Array<Array<Record<string, unknown>>> = [];
    let turnStartCalls = 0;

    fake.stdin.on('data', (chunk) => {
      const lines = String(chunk)
        .split(/\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        const payload = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
        };

        if (payload.method === 'initialized') {
          continue;
        }

        if (payload.method === 'initialize') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { sessionId: 'session-1' } }) + '\n');
          continue;
        }

        if (payload.method === 'model/list') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: { data: [{ id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', isDefault: true }], nextCursor: null },
          }) + '\n');
          continue;
        }

        if (payload.method === 'thread/start') {
          fake.stdout.write(JSON.stringify({ id: payload.id, result: { thread: { id: 'thread-1' } } }) + '\n');
          continue;
        }

        if (payload.method === 'turn/start') {
          turnStartCalls += 1;
          const input = Array.isArray(payload.params?.['input'])
            ? payload.params?.['input'] as Array<Record<string, unknown>>
            : [];
          observedInputs.push(input);

          if (turnStartCalls === 1) {
            fake.stdout.write(JSON.stringify({
              id: payload.id,
              error: {
                code: -32602,
                message: 'unknown variant localImage',
              },
            }) + '\n');
            continue;
          }

          fake.stdout.write(JSON.stringify({ id: payload.id, result: { turn: { id: 'turn-1' } } }) + '\n');
          setTimeout(() => {
            fake.stdout.write(JSON.stringify({
              method: 'turn/completed',
              params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
            }) + '\n');
          }, 5);
          continue;
        }
      }
    });

    const rpcClient = new CodexRpcClient({
      requestTimeoutMs: 5_000,
      spawnFactory: () => fake as any,
    });
    const provider = new OpenAICodexProvider('openai-codex/gpt-5.2', { rpcClient });

    for await (const _chunk of provider.stream(
      [{
        role: 'user',
        content: 'analyze',
        attachments: [{
          id: 'att-1',
          filename: 'photo.png',
          contentType: 'image/png',
          sizeBytes: 4,
          path: imagePath,
          url: '/api/uploads/image?sessionId=web%3Atest&id=att-1',
        }],
      }],
      { sessionId: 'session-fallback-image' }
    )) {
      // drain
    }

    expect(turnStartCalls).toBe(2);
    expect(observedInputs[0]?.[1]).toMatchObject({ type: 'localImage', path: imagePath });
    expect(observedInputs[1]?.[1]?.['type']).toBe('image');
    expect(String(observedInputs[1]?.[1]?.['url'])).toMatch(/^data:image\/png;base64,/);

    await provider.dispose();
  });
});
