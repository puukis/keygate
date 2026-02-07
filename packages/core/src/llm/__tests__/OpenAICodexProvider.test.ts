import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexRpcClient } from '../../codex/CodexRpcClient.js';
import { OpenAICodexProvider } from '../OpenAICodexProvider.js';

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

describe('OpenAICodexProvider', () => {
  it('completes ChatGPT login flow and parses model/list entries', async () => {
    const fake = new FakeChildProcess();
    let loggedIn = false;

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

        if (payload.method === 'account/read') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: {
              requiresOpenaiAuth: true,
              account: loggedIn ? { type: 'chatgpt', email: 'dev@example.com' } : null,
            },
          }) + '\n');
          continue;
        }

        if (payload.method === 'account/login/start') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: {
              loginId: 'login-1',
              authUrl: 'https://auth.example/login',
            },
          }) + '\n');

          loggedIn = true;
          setTimeout(() => {
            fake.stdout.write(JSON.stringify({
              method: 'account/login/completed',
              params: {
                loginId: 'login-1',
                success: true,
              },
            }) + '\n');
          }, 5);
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

    const openExternalUrl = vi.fn(async () => true);
    const provider = new OpenAICodexProvider('openai-codex/gpt-5.2', {
      rpcClient,
      openExternalUrl,
      loginTimeoutMs: 5_000,
    });

    await provider.login();

    expect(openExternalUrl).toHaveBeenCalledWith('https://auth.example/login');

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

        if (payload.method === 'account/read') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: {
              requiresOpenaiAuth: false,
              account: null,
            },
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

        if (payload.method === 'account/read') {
          fake.stdout.write(JSON.stringify({
            id: payload.id,
            result: {
              requiresOpenaiAuth: false,
              account: null,
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
});
