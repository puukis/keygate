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

describe('gateway skill slash dispatch', () => {
  afterEach(() => {
    Gateway.reset();
    vi.restoreAllMocks();
  });

  it('dispatches slash skill directly to configured tool', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-gateway-dispatch-'));
    await writeSkill(workspace, 'dispatch-skill', {
      commandDispatch: true,
    });

    const gateway = Gateway.getInstance(createConfig(workspace));

    gateway.toolExecutor.registerTool({
      name: 'dummy_dispatch',
      description: 'dummy',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
      },
      requiresConfirmation: false,
      type: 'other',
      handler: async (args) => ({
        success: true,
        output: `dispatched:${String(args['command'])}`,
      }),
    });

    const sent: string[] = [];
    const streamed: string[] = [];
    const channel = {
      type: 'web' as const,
      send: async (content: string) => {
        sent.push(content);
      },
      sendStream: async (stream: AsyncIterable<string>) => {
        for await (const chunk of stream) {
          streamed.push(chunk);
        }
      },
      requestConfirmation: async () => 'allow_once' as const,
    };

    const message: NormalizedMessage = {
      id: 'm1',
      sessionId: 'web:test',
      channelType: 'web',
      channel,
      userId: 'u1',
      content: '/dispatch-skill gateway status',
      timestamp: new Date(),
    };

    await gateway.processMessage(message);

    expect(sent).toEqual(['dispatched:gateway status']);
    expect(streamed).toEqual([]);
  });

  it('falls back to normal brain flow for unknown slash command', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-gateway-fallback-'));
    await writeSkill(workspace, 'dispatch-skill', {
      commandDispatch: true,
    });

    const gateway = Gateway.getInstance(createConfig(workspace));
    const runStreamSpy = vi.spyOn(gateway.brain, 'runStream').mockImplementation(async function* () {
      yield 'fallback-ok';
    });

    const sent: string[] = [];
    const streamed: string[] = [];
    const channel = {
      type: 'web' as const,
      send: async (content: string) => {
        sent.push(content);
      },
      sendStream: async (stream: AsyncIterable<string>) => {
        for await (const chunk of stream) {
          streamed.push(chunk);
        }
      },
      requestConfirmation: async () => 'allow_once' as const,
    };

    const message: NormalizedMessage = {
      id: 'm2',
      sessionId: 'web:test',
      channelType: 'web',
      channel,
      userId: 'u1',
      content: '/unknown-command hello',
      timestamp: new Date(),
    };

    await gateway.processMessage(message);

    expect(runStreamSpy).toHaveBeenCalledTimes(1);
    expect(streamed.join('')).toContain('fallback-ok');
    expect(sent).toEqual([]);
  });
});

async function writeSkill(
  workspace: string,
  name: string,
  options: { commandDispatch: boolean }
): Promise<void> {
  const skillDir = path.join(workspace, 'skills', name);
  await fs.mkdir(skillDir, { recursive: true });

  const commandFields = options.commandDispatch
    ? `command-dispatch: tool\ncommand-tool: dummy_dispatch\ncommand-arg-mode: raw\n`
    : '';

  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test skill\nuser-invocable: true\n${commandFields}---\nbody\n`,
    'utf8'
  );
}
