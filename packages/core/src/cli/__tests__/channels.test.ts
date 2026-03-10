import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseChannelAction, parseChannelName, runChannelsCommand } from '../commands/channels.js';
import type { ParsedArgs } from '../argv.js';

function makeArgs(channel?: string, action?: string): ParsedArgs {
  return {
    positional: channel && action ? ['channels', channel, action] : ['channels'],
    flags: {},
  };
}

function makeKillStub(livePids: Set<number>) {
  return (pid: number, signal?: NodeJS.Signals | number): void => {
    if (signal === 0 || signal === undefined) {
      if (!livePids.has(pid)) {
        const error = Object.assign(new Error(`kill ESRCH ${pid}`), { code: 'ESRCH' });
        throw error;
      }
      return;
    }

    livePids.delete(pid);
  };
}

describe('channels command', () => {
  it('parses channel name and action', () => {
    expect(parseChannelName('web')).toBe('web');
    expect(parseChannelName('discord')).toBe('discord');
    expect(parseChannelName('slack')).toBe('slack');
    expect(parseChannelName('whatsapp')).toBe('whatsapp');

    expect(parseChannelAction('start')).toBe('start');
    expect(parseChannelAction('stop')).toBe('stop');
    expect(parseChannelAction('restart')).toBe('restart');
    expect(parseChannelAction('status')).toBe('status');
    expect(parseChannelAction('config')).toBe('config');
    expect(parseChannelAction('login')).toBe('login');
    expect(parseChannelAction('logout')).toBe('logout');
    expect(parseChannelAction('open')).toBeNull();
  });

  it('throws usage for invalid syntax', async () => {
    await expect(runChannelsCommand(makeArgs())).rejects.toThrow(
      'Usage: keygate channels <web|discord|slack|whatsapp|telegram> <start|stop|restart|status|config|login|logout>'
    );
  });

  it('maps web lifecycle actions to gateway', async () => {
    const actions: string[] = [];
    await runChannelsCommand(makeArgs('web', 'start'), {
      runGatewayAction: async (action) => {
        actions.push(action);
      },
      log: () => undefined,
    });

    await runChannelsCommand(makeArgs('web', 'stop'), {
      runGatewayAction: async (action) => {
        actions.push(action);
      },
      log: () => undefined,
    });

    expect(actions).toEqual(['open', 'close']);
  });

  it('starts and stops managed discord process', async () => {
    const logs: string[] = [];
    const files = new Map<string, string>();
    const existingPaths = new Set<string>([
      '/repo/pnpm-workspace.yaml',
      '/repo/packages/discord/src/index.ts',
    ]);
    const livePids = new Set<number>();
    const configDir = '/tmp/keygate-config';
    const statePath = path.join(configDir, 'channels', 'discord.json');
    let spawned = 0;

    const deps = {
      cwd: '/repo',
      configDir,
      env: { DISCORD_TOKEN: 'discord-token' } as NodeJS.ProcessEnv,
      log: (line: string) => {
        logs.push(line);
      },
      hasCommand: (command: string) => command === 'pnpm',
      pathExists: (targetPath: string) => existingPaths.has(targetPath) || files.has(targetPath),
      readFile: async (targetPath: string) => {
        const value = files.get(targetPath);
        if (value === undefined) {
          throw new Error(`ENOENT: ${targetPath}`);
        }
        return value;
      },
      writeFile: async (targetPath: string, content: string) => {
        files.set(targetPath, content);
        existingPaths.add(targetPath);
      },
      mkdir: async () => undefined,
      unlink: async (targetPath: string) => {
        files.delete(targetPath);
        existingPaths.delete(targetPath);
      },
      spawnDetached: () => {
        spawned += 1;
        livePids.add(4321);
        return 4321;
      },
      kill: makeKillStub(livePids),
      now: () => new Date('2026-02-07T12:00:00.000Z'),
      runGatewayAction: async () => {
        throw new Error('unexpected gateway call');
      },
    };

    await runChannelsCommand(makeArgs('discord', 'start'), deps);
    expect(spawned).toBe(1);
    expect(files.has(statePath)).toBe(true);
    expect(logs.some((line) => line.includes('Discord channel status: running'))).toBe(true);

    await runChannelsCommand(makeArgs('discord', 'stop'), deps);
    expect(files.has(statePath)).toBe(false);
    expect(logs.some((line) => line.includes('Discord channel status: stopped'))).toBe(true);
  });

  it('requires token for discord start', async () => {
    await expect(
      runChannelsCommand(makeArgs('discord', 'start'), {
        configDir: '/tmp/keygate-test',
        cwd: '/repo',
        env: {} as NodeJS.ProcessEnv,
        log: () => undefined,
        pathExists: () => false,
      })
    ).rejects.toThrow('Discord token is missing');
  });

  it('prints discord config from environment', async () => {
    const logs: string[] = [];

    await runChannelsCommand(makeArgs('discord', 'config'), {
      cwd: '/repo',
      env: {
        DISCORD_TOKEN: 'discord-token',
        DISCORD_PREFIX: '!kg ',
        KEYGATE_DISCORD_START_COMMAND: 'node custom-discord.js',
      } as NodeJS.ProcessEnv,
      log: (line: string) => {
        logs.push(line);
      },
    });

    expect(logs.some((line) => line.includes('Token configured: yes'))).toBe(true);
    expect(logs.some((line) => line.includes('"!kg "'))).toBe(true);
    expect(logs.some((line) => line.includes('Launch command:'))).toBe(true);
  });

  it('requires slack bot token to start slack channel', async () => {
    await expect(
      runChannelsCommand(makeArgs('slack', 'start'), {
        cwd: '/repo',
        configDir: '/tmp/test-config',
        env: {} as NodeJS.ProcessEnv,
        log: () => undefined,
        pathExists: () => false,
      })
    ).rejects.toThrow('Slack bot token is missing');
  });

  it('requires slack app token to start slack channel', async () => {
    await expect(
      runChannelsCommand(makeArgs('slack', 'start'), {
        cwd: '/repo',
        configDir: '/tmp/test-config',
        env: { SLACK_BOT_TOKEN: 'xoxb-test' } as unknown as NodeJS.ProcessEnv,
        log: () => undefined,
        pathExists: () => false,
      })
    ).rejects.toThrow('Slack app token is missing');
  });

  it('prints slack config from environment', async () => {
    const logs: string[] = [];

    await runChannelsCommand(makeArgs('slack', 'config'), {
      cwd: '/repo',
      env: {
        SLACK_BOT_TOKEN: 'xoxb-test',
        SLACK_APP_TOKEN: 'xapp-test',
        KEYGATE_SLACK_START_COMMAND: 'node custom-slack.js',
      } as NodeJS.ProcessEnv,
      log: (line: string) => {
        logs.push(line);
      },
    });

    expect(logs.some((line) => line.includes('Bot token configured: yes'))).toBe(true);
    expect(logs.some((line) => line.includes('App token configured: yes'))).toBe(true);
    expect(logs.some((line) => line.includes('Launch command:'))).toBe(true);
  });

  it('reports slack channel status as stopped when no state file exists', async () => {
    const logs: string[] = [];

    await runChannelsCommand(makeArgs('slack', 'status'), {
      cwd: '/repo',
      configDir: '/tmp/test-config',
      env: {} as NodeJS.ProcessEnv,
      log: (line: string) => {
        logs.push(line);
      },
      pathExists: () => false,
    });

    expect(logs.some((line) => line.includes('Slack channel status: stopped'))).toBe(true);
  });

  it('requires linked auth before starting whatsapp channel', async () => {
    await expect(
      runChannelsCommand(makeArgs('whatsapp', 'start'), {
        cwd: '/repo',
        configDir: '/tmp/test-config',
        env: {} as NodeJS.ProcessEnv,
        log: () => undefined,
        pathExists: () => false,
      })
    ).rejects.toThrow('WhatsApp is not linked');
  });
});
