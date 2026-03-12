import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/index.js', () => ({
  Database: class MockDatabase {
    getSession() {
      return null;
    }

    listSessions() {
      return [];
    }

    saveSession() {
      return undefined;
    }

    saveMessage() {
      return undefined;
    }

    clearSession() {
      return undefined;
    }
  },
}));

import { Gateway } from '../Gateway.js';
import type { KeygateConfig, NormalizedMessage } from '../../types.js';

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

function createChannel() {
  const sent: string[] = [];
  const streamed: string[] = [];
  const channel = {
    type: 'web' as const,
    send: vi.fn(async (content: string) => {
      sent.push(content);
    }),
    sendStream: vi.fn(async (stream: AsyncIterable<string>) => {
      for await (const chunk of stream) {
        streamed.push(chunk);
      }
    }),
    requestConfirmation: vi.fn(async () => 'allow_once' as const),
  };

  return { channel, sent, streamed };
}

describe('Gateway immediate /stop handling', () => {
  afterEach(() => {
    Gateway.reset();
    vi.restoreAllMocks();
  });

  it('handles /stop immediately even while the session lane is busy', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-gateway-stop-'));
    const gateway = Gateway.getInstance(createConfig(workspace));
    const { channel, sent, streamed } = createChannel();

    vi.spyOn(gateway.brain, 'runStream').mockImplementation((_session, _channel, options) => (async function* () {
      yield 'working';
      await new Promise<void>((resolve) => {
        if (options?.runContext?.signal?.aborted) {
          resolve();
          return;
        }
        options?.runContext?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      yield 'done';
    })());

    const userMessage: NormalizedMessage = {
      id: 'm1',
      sessionId: 'web:test',
      channelType: 'web',
      userId: 'u1',
      channel,
      content: 'do something long',
      timestamp: new Date(),
    };

    const stopMessage: NormalizedMessage = {
      id: 'm2',
      sessionId: 'web:test',
      channelType: 'web',
      userId: 'u1',
      channel,
      content: '/stop',
      timestamp: new Date(),
    };

    const firstRun = gateway.processMessage(userMessage);
    await vi.waitFor(() => expect(streamed).toContain('working'));

    const stopResult = await Promise.race([
      gateway.processMessage(stopMessage).then(() => 'resolved'),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);

    expect(stopResult).toBe('resolved');
    expect(sent).toContain('Stopped the active run for this session.');
    await expect(firstRun).resolves.toBeUndefined();
  });
});
