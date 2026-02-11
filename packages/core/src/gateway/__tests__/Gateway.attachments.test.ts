import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockDbState = vi.hoisted(() => ({
  instances: [] as Array<{
    saveMessageCalls: Array<{ sessionId: string; message: Record<string, unknown> }>;
    clearSessionCalls: string[];
  }>,
  attachmentPathsBySession: {} as Record<string, string[]>,
}));

vi.mock('../../db/index.js', () => ({
  Database: class MockDatabase {
    saveMessageCalls: Array<{ sessionId: string; message: Record<string, unknown> }> = [];
    clearSessionCalls: string[] = [];

    constructor() {
      mockDbState.instances.push(this);
    }

    getSession() {
      return null;
    }

    listSessions() {
      return [];
    }

    saveSession() {
      return undefined;
    }

    saveMessage(sessionId: string, message: Record<string, unknown>) {
      this.saveMessageCalls.push({ sessionId, message });
    }

    clearSession(sessionId: string) {
      this.clearSessionCalls.push(sessionId);
    }

    getSessionAttachmentPaths(sessionId: string) {
      return mockDbState.attachmentPathsBySession[sessionId] ?? [];
    }

    close() {
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
  return {
    type: 'web' as const,
    send: vi.fn(async () => undefined),
    sendStream: vi.fn(async (stream: AsyncIterable<string>) => {
      for await (const _chunk of stream) {
        // drain
      }
    }),
    requestConfirmation: vi.fn(async () => 'allow_once' as const),
  };
}

describe('Gateway attachment persistence and cleanup', () => {
  afterEach(() => {
    Gateway.reset();
    vi.restoreAllMocks();
    mockDbState.instances = [];
    mockDbState.attachmentPathsBySession = {};
  });

  it('persists and emits user attachments', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-gateway-attachments-'));
    const gateway = Gateway.getInstance(createConfig(workspace));
    vi.spyOn(gateway.brain, 'runStream').mockImplementation(async function* () {
      yield 'assistant answer';
    });

    const channel = createChannel();
    const attachmentPath = path.join(workspace, '.keygate-uploads', 'web:test', 'att-1.png');
    await fs.mkdir(path.dirname(attachmentPath), { recursive: true });
    await fs.writeFile(attachmentPath, 'img', 'utf8');

    const events: Array<Record<string, unknown>> = [];
    gateway.on('message:user', (event) => {
      events.push(event as unknown as Record<string, unknown>);
    });

    const message: NormalizedMessage = {
      id: 'm1',
      sessionId: 'web:test',
      channelType: 'web',
      userId: 'u1',
      channel,
      content: 'please analyze',
      attachments: [{
        id: 'att-1',
        filename: 'photo.png',
        contentType: 'image/png',
        sizeBytes: 3,
        path: attachmentPath,
        url: '/api/uploads/image?sessionId=web%3Atest&id=att-1',
      }],
      timestamp: new Date('2026-02-11T10:00:00.000Z'),
    };

    await gateway.processMessage(message);

    const db = mockDbState.instances[0];
    expect(db).toBeDefined();
    expect(db?.saveMessageCalls[0]?.message['attachments']).toEqual([{
      id: 'att-1',
      filename: 'photo.png',
      contentType: 'image/png',
      sizeBytes: 3,
      path: attachmentPath,
      url: '/api/uploads/image?sessionId=web%3Atest&id=att-1',
    }]);

    expect(events).toHaveLength(1);
    expect(events[0]?.['attachments']).toEqual([{
      id: 'att-1',
      filename: 'photo.png',
      contentType: 'image/png',
      sizeBytes: 3,
      path: attachmentPath,
      url: '/api/uploads/image?sessionId=web%3Atest&id=att-1',
    }]);

    const persistedSession = gateway.getSession('web:test');
    expect(persistedSession?.messages[0]?.attachments?.[0]?.id).toBe('att-1');
  });

  it('deletes attachment files on clearSession using in-memory and DB metadata', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-gateway-clear-'));
    const gateway = Gateway.getInstance(createConfig(workspace));
    vi.spyOn(gateway.brain, 'runStream').mockImplementation(async function* () {
      yield 'assistant answer';
    });

    const sessionId = 'web:test';
    const inMemoryPath = path.join(workspace, '.keygate-uploads', sessionId, 'in-memory.png');
    const dbPath = path.join(workspace, '.keygate-uploads', sessionId, 'db-path.png');

    await fs.mkdir(path.dirname(inMemoryPath), { recursive: true });
    await fs.writeFile(inMemoryPath, 'mem', 'utf8');
    await fs.writeFile(dbPath, 'db', 'utf8');

    mockDbState.attachmentPathsBySession[sessionId] = [dbPath];

    const channel = createChannel();
    await gateway.processMessage({
      id: 'm1',
      sessionId,
      channelType: 'web',
      userId: 'u1',
      channel,
      content: 'clear me',
      attachments: [{
        id: 'att-1',
        filename: 'in-memory.png',
        contentType: 'image/png',
        sizeBytes: 3,
        path: inMemoryPath,
        url: '/api/uploads/image?sessionId=web%3Atest&id=att-1',
      }],
      timestamp: new Date('2026-02-11T10:00:00.000Z'),
    });

    gateway.clearSession(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(fs.access(inMemoryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(dbPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const db = mockDbState.instances[0];
    expect(db?.clearSessionCalls).toContain(sessionId);
  });
});
