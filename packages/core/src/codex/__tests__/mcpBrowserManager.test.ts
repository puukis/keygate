import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildDomainPolicyFlags,
  buildPlaywrightMcpArgs,
  CODEX_REASONING_EFFORT_COMPAT,
  MCPBrowserManager,
} from '../mcpBrowserManager.js';
import type { KeygateConfig } from '../../types.js';

interface CallRecord {
  command: string;
  args: string[];
}

class FakeCodexRunner {
  calls: CallRecord[] = [];
  private server: {
    name: string;
    transport: {
      type: 'stdio';
      command: string;
      args: string[];
      env: null;
      env_vars: string[];
      cwd: null;
    };
    enabled: boolean;
  } | null = null;

  run = (command: string, args: string[]): { status: number; stdout: string; stderr: string } => {
    this.calls.push({ command, args: [...args] });

    const subArgs = args.slice(2);
    if (args[0] !== '-c' || args[1] !== CODEX_REASONING_EFFORT_COMPAT) {
      return { status: 1, stdout: '', stderr: 'Missing compatibility override' };
    }

    if (subArgs[0] !== 'mcp') {
      return { status: 1, stdout: '', stderr: 'Unsupported command' };
    }

    const action = subArgs[1];

    if (action === 'list') {
      return {
        status: 0,
        stdout: JSON.stringify(this.server ? [this.server] : []),
        stderr: '',
      };
    }

    if (action === 'get') {
      const name = subArgs[2];
      if (!this.server || this.server.name !== name) {
        return { status: 1, stdout: '', stderr: `No MCP server named '${name}' found.` };
      }
      return { status: 0, stdout: JSON.stringify(this.server), stderr: '' };
    }

    if (action === 'add') {
      const name = subArgs[2]!;
      const serverCommand = subArgs[3]!;
      const serverArgs = subArgs.slice(4);

      this.server = {
        name,
        enabled: true,
        transport: {
          type: 'stdio',
          command: serverCommand,
          args: serverArgs,
          env: null,
          env_vars: [],
          cwd: null,
        },
      };

      return { status: 0, stdout: `Added global MCP server '${name}'.`, stderr: '' };
    }

    if (action === 'remove') {
      const name = subArgs[2];
      if (!this.server || this.server.name !== name) {
        return { status: 0, stdout: `No MCP server named '${name}' found.`, stderr: '' };
      }

      this.server = null;
      return { status: 0, stdout: `Removed global MCP server '${name}'.`, stderr: '' };
    }

    return { status: 1, stdout: '', stderr: `Unsupported mcp action: ${action}` };
  };
}

function createConfig(overrides: Partial<KeygateConfig['browser']> = {}): KeygateConfig {
  const workspacePath = path.join(os.tmpdir(), `keygate-mcp-test-${Date.now()}`);
  return {
    llm: {
      provider: 'openai-codex',
      model: 'openai-codex/gpt-5.3',
      reasoningEffort: 'medium',
      apiKey: '',
      ollama: {
        host: 'http://127.0.0.1:11434',
      },
    },
    security: {
      mode: 'safe',
      spicyModeEnabled: false,
      spicyMaxObedienceEnabled: false,
      workspacePath,
      allowedBinaries: ['git'],
    },
    server: {
      port: 18790,
    },
    browser: {
      domainPolicy: 'none',
      domainAllowlist: [],
      domainBlocklist: [],
      traceRetentionDays: 7,
      mcpPlaywrightVersion: '0.0.64',
      artifactsPath: path.join(workspacePath, '.keygate-browser-runs'),
      ...overrides,
    },
    discord: {
      token: '',
      prefix: '!keygate ',
    },
  };
}

describe('mcpBrowserManager', () => {
  it('builds codex mcp add using compatibility override and pinned version', async () => {
    const runner = new FakeCodexRunner();
    const config = createConfig();
    const manager = new MCPBrowserManager(config, {
      runCommand: runner.run,
    });

    const status = await manager.setup();

    expect(status.installed).toBe(true);
    const addCall = runner.calls.find((call) => call.args.includes('add'));
    expect(addCall).toBeTruthy();
    expect(addCall?.args[0]).toBe('-c');
    expect(addCall?.args[1]).toBe(CODEX_REASONING_EFFORT_COMPAT);
    expect(addCall?.args).toContain('@playwright/mcp@0.0.64');
    expect(addCall?.args).toContain('--output-dir');
    expect(addCall?.args).toContain(path.resolve(config.browser.artifactsPath));
  });

  it('keeps setup idempotent when desired config is already installed', async () => {
    const runner = new FakeCodexRunner();
    const config = createConfig();
    const manager = new MCPBrowserManager(config, {
      runCommand: runner.run,
    });

    await manager.setup();
    await manager.setup();

    const addCalls = runner.calls.filter((call) => call.args.includes('add'));
    expect(addCalls).toHaveLength(1);
  });

  it('maps domain policy variants to expected flags', () => {
    expect(buildDomainPolicyFlags('none', ['https://a.test'], ['https://b.test'])).toEqual([]);
    expect(buildDomainPolicyFlags('allowlist', ['https://a.test', ' https://b.test '], [])).toEqual([
      '--allowed-origins',
      'https://a.test,https://b.test',
    ]);
    expect(buildDomainPolicyFlags('blocklist', [], ['https://ads.test'])).toEqual([
      '--blocked-origins',
      'https://ads.test',
    ]);
  });

  it('includes domain policy flags in playwright command args', () => {
    const config = createConfig({
      domainPolicy: 'allowlist',
      domainAllowlist: ['https://example.com', 'https://docs.example.com'],
    });

    expect(buildPlaywrightMcpArgs(config)).toEqual(expect.arrayContaining([
      '--allowed-origins',
      'https://example.com,https://docs.example.com',
    ]));
  });

  it('cleans up browser artifacts older than configured retention', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-browser-retention-'));
    const oldFile = path.join(root, 'session-web:1-step-1.png');
    const recentFile = path.join(root, 'session-web:1-step-2.png');

    await fs.writeFile(oldFile, 'old', 'utf8');
    await fs.writeFile(recentFile, 'new', 'utf8');

    const oldTimestamp = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
    const recentTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(oldFile, oldTimestamp, oldTimestamp);
    await fs.utimes(recentFile, recentTimestamp, recentTimestamp);

    const manager = new MCPBrowserManager(createConfig({
      artifactsPath: root,
      traceRetentionDays: 7,
    }), {
      runCommand: () => ({ status: 0, stdout: '[]', stderr: '' }),
    });

    const result = await manager.cleanupArtifacts();

    expect(result.deletedFiles).toBe(1);
    await expect(fs.stat(recentFile)).resolves.toBeTruthy();
    await expect(fs.stat(oldFile)).rejects.toThrow();
  });
});
