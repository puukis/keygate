import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedArgs } from '../argv.js';

const { spawnSync } = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync,
}));

vi.mock('../../config/env.js', () => ({
  loadConfigFromEnv: vi.fn(() => ({})),
}));

vi.mock('../../codex/mcpBrowserManager.js', () => ({
  MCPBrowserManager: class {
    async status(): Promise<{ installed: boolean }> {
      return { installed: false };
    }

    async update(): Promise<{ desiredVersion: string }> {
      return { desiredVersion: 'unknown' };
    }
  },
}));

import { runUpdateCommand } from '../commands/update.js';

function parseArgs(argv: string[]): ParsedArgs {
  return {
    positional: argv,
    flags: {},
  };
}

function commandResult(status: number | null, stdout = '', stderr = ''): {
  status: number | null;
  stdout: string;
  stderr: string;
  error: undefined;
} {
  return {
    status,
    stdout,
    stderr,
    error: undefined,
  };
}

describe('update command', () => {
  const originalArgv = [...process.argv];

  beforeEach(() => {
    process.argv[1] = '/tmp/keygate-cli/dist/main.js';
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    spawnSync.mockReset();
    vi.restoreAllMocks();
  });

  it('falls back to latest installable npm version when latest has workspace protocol deps', async () => {
    let npmListCalls = 0;

    spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command !== 'npm') {
        throw new Error(`Unexpected command: ${command}`);
      }

      const key = args.join(' ');

      if (key === '--version') {
        return commandResult(0, '10.8.0\n');
      }

      if (key === 'list -g --depth=0 --json @puukis/cli') {
        npmListCalls += 1;
        const version = npmListCalls === 1 ? '0.1.4' : '0.1.5';
        return commandResult(
          0,
          JSON.stringify({
            dependencies: {
              '@puukis/cli': { version },
            },
          })
        );
      }

      if (key === 'view @puukis/cli version') {
        return commandResult(0, '0.1.8\n');
      }

      if (key === 'install -g @puukis/cli@latest') {
        return commandResult(
          1,
          '',
          'npm ERR! code EUNSUPPORTEDPROTOCOL\nnpm ERR! Unsupported URL Type "workspace:": workspace:*'
        );
      }

      if (key === 'view @puukis/cli versions --json') {
        return commandResult(0, JSON.stringify(['0.1.4', '0.1.5', '0.1.7', '0.1.8']));
      }

      if (key === 'view @puukis/cli@0.1.8 --json') {
        return commandResult(
          0,
          JSON.stringify({
            dependencies: {
              '@puukis/core': 'workspace:*',
            },
          })
        );
      }

      if (key === 'view @puukis/cli@0.1.7 --json') {
        return commandResult(
          0,
          JSON.stringify({
            dependencies: {
              '@puukis/core': 'workspace:*',
            },
          })
        );
      }

      if (key === 'view @puukis/cli@0.1.5 --json') {
        return commandResult(
          0,
          JSON.stringify({
            dependencies: {
              '@puukis/core': '^0.1.1',
            },
          })
        );
      }

      if (key === 'install -g @puukis/cli@0.1.5') {
        return commandResult(0, 'added 1 package\n');
      }

      throw new Error(`Unexpected npm args: ${key}`);
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runUpdateCommand(parseArgs(['update']));

    expect(spawnSync).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', '@puukis/cli@0.1.5'],
      expect.objectContaining({ encoding: 'utf8' })
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Latest npm version is not installable via npm')
    );
    expect(logSpy).toHaveBeenCalledWith('- note: latest npm version is currently not installable via npm');
  });
});
