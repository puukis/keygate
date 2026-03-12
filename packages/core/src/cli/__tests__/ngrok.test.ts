import { describe, expect, it, vi } from 'vitest';
import {
  buildNgrokLaunchdPlistContent,
  parseNgrokAction,
  runNgrokCommand,
  type NgrokDeps,
} from '../commands/ngrok.js';
import type { ParsedArgs } from '../argv.js';

function makeArgs(action?: string): ParsedArgs {
  return {
    positional: action ? ['ngrok', action] : ['ngrok'],
    flags: {},
  };
}

function commandResult(
  status: number | null,
  stdout = '',
  stderr = '',
  error?: Error
): { status: number | null; stdout: string; stderr: string; error: Error | undefined } {
  return { status, stdout, stderr, error };
}

function createDeps(overrides: Partial<NgrokDeps> = {}): NgrokDeps {
  return {
    platform: 'darwin',
    uid: 501,
    homeDir: '/Users/tester',
    configDir: '/Users/tester/.keygate',
    log: () => undefined,
    mkdir: async () => undefined,
    writeFile: async () => undefined,
    runCommand: () => commandResult(0),
    readFile: async () => '',
    fetchJson: async () => ({ tunnels: [] }),
    sleep: async () => undefined,
    ...overrides,
  };
}

describe('ngrok command', () => {
  it('parses valid ngrok actions', () => {
    expect(parseNgrokAction('start')).toBe('start');
    expect(parseNgrokAction('stop')).toBe('stop');
    expect(parseNgrokAction('status')).toBe('status');
    expect(parseNgrokAction('restart')).toBe('restart');
    expect(parseNgrokAction('url')).toBe('url');
  });

  it('rejects invalid ngrok actions', () => {
    expect(parseNgrokAction(undefined)).toBeNull();
    expect(parseNgrokAction('open')).toBeNull();
  });

  it('throws usage for invalid command syntax', async () => {
    await expect(runNgrokCommand(makeArgs('nope'))).rejects.toThrow(
      'Usage: keygate ngrok <start|stop|status|restart|url>'
    );
  });

  it('generates launchd plist content for the managed tunnel', () => {
    const plist = buildNgrokLaunchdPlistContent('/opt/homebrew/bin/ngrok', 18790, '/Users/tester/.keygate/ngrok.log');
    expect(plist).toContain('<string>com.keygate.ngrok</string>');
    expect(plist).toContain('<string>/opt/homebrew/bin/ngrok</string>');
    expect(plist).toContain('<string>18790</string>');
    expect(plist).toContain('<string>/Users/tester/.keygate/ngrok.log</string>');
    expect(plist).toContain('<key>KeepAlive</key>');
  });

  it('starts the launch agent and prints the public URL', async () => {
    const logs: string[] = [];
    const writes: Array<{ targetPath: string; content: string }> = [];
    let statusChecks = 0;
    const runCommand = vi.fn((command: string, args: string[]) => {
      const joined = `${command} ${args.join(' ')}`;

      if (joined === 'launchctl --help') return commandResult(0);
      if (joined === 'which ngrok') return commandResult(0, '/opt/homebrew/bin/ngrok\n');
      if (joined === '/opt/homebrew/bin/ngrok version') return commandResult(0, 'ngrok version 3.0.0\n');
      if (joined === 'launchctl bootstrap gui/501 /Users/tester/Library/LaunchAgents/com.keygate.ngrok.plist') {
        return commandResult(0);
      }
      if (joined === 'launchctl kickstart -k gui/501/com.keygate.ngrok') {
        return commandResult(0);
      }
      if (joined === 'launchctl print gui/501/com.keygate.ngrok') {
        statusChecks += 1;
        if (statusChecks === 1) {
          return commandResult(113, '', 'Could not find service "com.keygate.ngrok" in domain for user gui: 501');
        }

        return commandResult(
          0,
          [
            'gui/501/com.keygate.ngrok = {',
            '  active count = 1',
            '  state = running',
            '  pid = 763',
            '}',
          ].join('\n')
        );
      }

      throw new Error(`Unexpected command: ${joined}`);
    });

    await runNgrokCommand(makeArgs('start'), createDeps({
      runCommand,
      writeFile: vi.fn(async (targetPath: string, content: string) => {
        writes.push({ targetPath, content });
      }),
      log: (line: string) => {
        logs.push(line);
      },
      fetchJson: async () => ({
        tunnels: [
          {
            public_url: 'https://keygate-test.ngrok-free.app',
            proto: 'https',
          },
        ],
      }),
    }));

    expect(writes).toHaveLength(1);
    expect(writes[0]?.targetPath).toBe('/Users/tester/Library/LaunchAgents/com.keygate.ngrok.plist');
    expect(writes[0]?.content).toContain('/opt/homebrew/bin/ngrok');
    expect(writes[0]?.content).toContain('<string>18790</string>');
    expect(logs.some((line) => line.includes('Ngrok start requested'))).toBe(true);
    expect(logs.some((line) => line.includes('Ngrok status: running'))).toBe(true);
    expect(logs.some((line) => line.includes('Public URL: https://keygate-test.ngrok-free.app'))).toBe(true);
  });

  it('surfaces launchd crash traces from the ngrok log', async () => {
    const logs: string[] = [];

    await runNgrokCommand(makeArgs('status'), createDeps({
      runCommand: (command: string, args: string[]) => {
        const joined = `${command} ${args.join(' ')}`;
        if (joined === 'launchctl print gui/501/com.keygate.ngrok') {
          return commandResult(
            0,
            [
              'gui/501/com.keygate.ngrok = {',
              '  active count = 0',
              '  state = spawn scheduled',
              '  last exit code = 1',
              '}',
            ].join('\n')
          );
        }

        return commandResult(0);
      },
      readFile: async () => 'Error: auth failed\nstack line 1\nstack line 2\n',
      log: (line: string) => {
        logs.push(line);
      },
    }));

    expect(logs.some((line) => line.includes('Ngrok status: unknown'))).toBe(true);
    expect(logs.some((line) => line.includes('last exit code=1'))).toBe(true);
    expect(logs.some((line) => line.includes('stack line 2'))).toBe(true);
  });

  it('prints the active public URL directly', async () => {
    const logs: string[] = [];

    await runNgrokCommand(makeArgs('url'), createDeps({
      runCommand: (command: string, args: string[]) => {
        const joined = `${command} ${args.join(' ')}`;
        if (joined === 'launchctl print gui/501/com.keygate.ngrok') {
          return commandResult(
            0,
            [
              'gui/501/com.keygate.ngrok = {',
              '  active count = 1',
              '  state = running',
              '  pid = 763',
              '}',
            ].join('\n')
          );
        }

        return commandResult(0);
      },
      fetchJson: async () => ({
        tunnels: [
          {
            public_url: 'https://keygate-live.ngrok-free.app',
            proto: 'https',
          },
        ],
      }),
      log: (line: string) => {
        logs.push(line);
      },
    }));

    expect(logs).toEqual(['https://keygate-live.ngrok-free.app']);
  });
});
