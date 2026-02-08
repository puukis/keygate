import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildLaunchdPlistContent,
  buildLinuxUnitContent,
  buildPowerShellLauncherContent,
  createGatewayAdapter,
  parseGatewayAction,
  runGatewayCommand,
  type GatewayDeps,
} from '../commands/gateway.js';
import type { ParsedArgs } from '../argv.js';

function makeArgs(command: string, action?: string): ParsedArgs {
  return {
    positional: action ? [command, action] : [command],
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

function createDeps(overrides: Partial<GatewayDeps> = {}): GatewayDeps {
  return {
    platform: 'linux',
    uid: 501,
    cwd: '/tmp/keygate',
    homeDir: '/Users/tester',
    configDir: '/tmp/keygate-config',
    configHomeDir: '/tmp/config-home',
    envPath: '/usr/local/bin:/usr/bin:/bin',
    envPathExt: '.EXE;.CMD;.BAT;.COM',
    envCodexBin: undefined,
    argv1: '/tmp/keygate/dist/main.js',
    execPath: '/usr/local/bin/node',
    log: () => undefined,
    mkdir: async () => undefined,
    writeFile: async () => undefined,
    chmod: async () => undefined,
    runCommand: () => commandResult(0),
    ...overrides,
  };
}

describe('gateway command', () => {
  it('parses valid gateway actions', () => {
    expect(parseGatewayAction('open')).toBe('open');
    expect(parseGatewayAction('close')).toBe('close');
    expect(parseGatewayAction('status')).toBe('status');
    expect(parseGatewayAction('restart')).toBe('restart');
  });

  it('rejects invalid gateway actions', () => {
    expect(parseGatewayAction(undefined)).toBeNull();
    expect(parseGatewayAction('start')).toBeNull();
  });

  it('throws usage for invalid command syntax', async () => {
    await expect(runGatewayCommand(makeArgs('gateway', 'nope'))).rejects.toThrow(
      'Usage: keygate gateway <open|close|status|restart>'
    );
  });

  it('restarts by closing then opening the gateway', async () => {
    const logs: string[] = [];
    const calls: string[] = [];
    let statusChecks = 0;
    const runCommand = vi.fn((command: string, args: string[]) => {
      const joined = `${command} ${args.join(' ')}`;
      calls.push(joined);

      if (joined === 'systemctl --help') return commandResult(0);
      if (joined === 'systemctl --user show-environment') return commandResult(0, 'PATH=/usr/bin\n');
      if (joined === 'systemctl --user daemon-reload') return commandResult(0);
      if (joined === 'systemctl --user stop keygate-gateway.service') return commandResult(0);
      if (joined === 'systemctl --user start keygate-gateway.service') return commandResult(0);
      if (joined === 'systemctl --user is-active keygate-gateway.service') {
        statusChecks += 1;
        return commandResult(statusChecks >= 1 ? 0 : 3, statusChecks >= 1 ? 'active\n' : 'inactive\n');
      }
      if (
        joined ===
        'systemctl --user show keygate-gateway.service --property=ActiveState,SubState,UnitFileState --value'
      ) {
        return commandResult(0, 'active\nrunning\nenabled\n');
      }

      throw new Error(`Unexpected command: ${joined}`);
    });

    await runGatewayCommand(makeArgs('gateway', 'restart'), {
      platform: 'linux',
      configDir: '/tmp/keygate-config',
      configHomeDir: '/tmp/config-home',
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      chmod: vi.fn(async () => undefined),
      runCommand,
      log: (line: string) => {
        logs.push(line);
      },
    });

    const stopIndex = calls.findIndex((value) => value === 'systemctl --user stop keygate-gateway.service');
    const startIndex = calls.findIndex((value) => value === 'systemctl --user start keygate-gateway.service');

    expect(stopIndex).toBeGreaterThan(-1);
    expect(startIndex).toBeGreaterThan(stopIndex);
    expect(logs.some((line) => line.includes('Gateway restart requested'))).toBe(true);
    expect(logs.some((line) => line.includes('Gateway status: running'))).toBe(true);
  });

  it('selects platform adapters and rejects unsupported platforms', () => {
    const deps = createDeps();

    expect(typeof createGatewayAdapter('linux', deps).open).toBe('function');
    expect(typeof createGatewayAdapter('darwin', { ...deps, platform: 'darwin' }).open).toBe('function');
    expect(typeof createGatewayAdapter('win32', { ...deps, platform: 'win32' }).open).toBe('function');

    expect(() => createGatewayAdapter('aix', deps)).toThrow('Unsupported platform');
  });

  it('generates service definition content with disabled browser auto-open', () => {
    const linuxUnit = buildLinuxUnitContent('/tmp/keygate/launch-keygate.sh');
    expect(linuxUnit).toContain('Environment=KEYGATE_OPEN_CHAT_ON_START=false');

    const launchdPlist = buildLaunchdPlistContent('/tmp/keygate/launch-keygate.sh');
    expect(launchdPlist).toContain('<key>KEYGATE_OPEN_CHAT_ON_START</key>');
    expect(launchdPlist).toContain('<string>false</string>');

    const psRunner = buildPowerShellLauncherContent({
      command: 'keygate',
      args: ['serve'],
      env: {},
    });
    expect(psRunner).toContain("$env:KEYGATE_OPEN_CHAT_ON_START = 'false'");
  });

  it('writes launcher with PATH and explicit codex binary when available', async () => {
    const writes: Array<{ targetPath: string; content: string }> = [];
    const runCommand = vi.fn((command: string, args: string[]) => {
      const joined = `${command} ${args.join(' ')}`;
      if (joined === 'systemctl --help') return commandResult(0);
      if (joined === 'systemctl --user show-environment') return commandResult(0, 'PATH=/usr/bin\n');
      if (joined === 'systemctl --user daemon-reload') return commandResult(0);
      if (joined === 'systemctl --user is-active keygate-gateway.service') return commandResult(0, 'active\n');
      if (
        joined ===
        'systemctl --user show keygate-gateway.service --property=ActiveState,SubState,UnitFileState --value'
      ) {
        return commandResult(0, 'active\nrunning\nenabled\n');
      }
      throw new Error(`Unexpected command: ${joined}`);
    });

    await runGatewayCommand(makeArgs('gateway', 'open'), {
      platform: 'linux',
      envPath: '/custom/bin:/usr/bin',
      envCodexBin: '/custom/bin/codex',
      writeFile: vi.fn(async (targetPath: string, content: string) => {
        writes.push({ targetPath, content });
      }),
      mkdir: vi.fn(async () => undefined),
      chmod: vi.fn(async () => undefined),
      runCommand,
      log: () => undefined,
    });

    const launcher = writes.find((entry) => entry.targetPath.endsWith('launch-keygate.sh'));
    expect(launcher).toBeDefined();
    expect(launcher?.content).toContain("export PATH='/custom/bin:/usr/bin'");
    expect(launcher?.content).toContain("export KEYGATE_CODEX_BIN='/custom/bin/codex'");
  });

  it('treats open as idempotent when linux unit is already running', async () => {
    const logs: string[] = [];
    const runCommand = vi.fn((command: string, args: string[]) => {
      const joined = `${command} ${args.join(' ')}`;

      if (joined === 'systemctl --help') return commandResult(0);
      if (joined === 'systemctl --user show-environment') return commandResult(0, 'PATH=/usr/bin\n');
      if (joined === 'systemctl --user daemon-reload') return commandResult(0);
      if (joined === 'systemctl --user is-active keygate-gateway.service') return commandResult(0, 'active\n');
      if (
        joined ===
        'systemctl --user show keygate-gateway.service --property=ActiveState,SubState,UnitFileState --value'
      ) {
        return commandResult(0, 'active\nrunning\nenabled\n');
      }

      throw new Error(`Unexpected command: ${joined}`);
    });

    await runGatewayCommand(makeArgs('gateway', 'open'), {
      platform: 'linux',
      configDir: '/tmp/keygate-config',
      configHomeDir: '/tmp/config-home',
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      chmod: vi.fn(async () => undefined),
      runCommand,
      log: (line: string) => {
        logs.push(line);
      },
    });

    const calledStart = runCommand.mock.calls.some(
      ([command, args]) =>
        command === 'systemctl' && Array.isArray(args) && args[0] === '--user' && args[1] === 'start'
    );

    expect(calledStart).toBe(false);
    expect(logs.some((line) => line.includes('already running'))).toBe(true);
    expect(logs.some((line) => line.includes('Gateway status: running'))).toBe(true);
  });

  it('treats close as idempotent when linux unit is already stopped', async () => {
    const logs: string[] = [];
    const runCommand = vi.fn((command: string, args: string[]) => {
      const joined = `${command} ${args.join(' ')}`;

      if (joined === 'systemctl --help') return commandResult(0);
      if (joined === 'systemctl --user show-environment') return commandResult(0, 'PATH=/usr/bin\n');
      if (joined === 'systemctl --user daemon-reload') return commandResult(0);
      if (joined === 'systemctl --user is-active keygate-gateway.service') return commandResult(3, 'inactive\n');
      if (
        joined ===
        'systemctl --user show keygate-gateway.service --property=ActiveState,SubState,UnitFileState --value'
      ) {
        return commandResult(0, 'inactive\ndead\ndisabled\n');
      }

      throw new Error(`Unexpected command: ${joined}`);
    });

    await runGatewayCommand(makeArgs('gateway', 'close'), {
      platform: 'linux',
      configDir: '/tmp/keygate-config',
      configHomeDir: '/tmp/config-home',
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      chmod: vi.fn(async () => undefined),
      runCommand,
      log: (line: string) => {
        logs.push(line);
      },
    });

    const calledStop = runCommand.mock.calls.some(
      ([command, args]) =>
        command === 'systemctl' && Array.isArray(args) && args[0] === '--user' && args[1] === 'stop'
    );

    expect(calledStop).toBe(false);
    expect(logs.some((line) => line.includes('already stopped'))).toBe(true);
    expect(logs.some((line) => line.includes('Gateway status: stopped'))).toBe(true);
  });

  it('returns guidance when native manager is unavailable', async () => {
    const missingBinaryError = Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' });
    const runCommand = vi.fn(() => commandResult(null, '', '', missingBinaryError));

    await expect(
      runGatewayCommand(makeArgs('gateway', 'status'), {
        platform: 'linux',
        runCommand,
      })
    ).rejects.toThrow('keygate serve');
  });

  it('invokes windows scheduler commands for open lifecycle', async () => {
    const logs: string[] = [];
    let statusChecks = 0;

    const runCommand = vi.fn((command: string, args: string[]) => {
      const joined = `${command} ${args.join(' ')}`;

      if (joined === 'powershell --help' || joined === 'schtasks /?') {
        return commandResult(0);
      }

      if (
        command === 'powershell' &&
        args.includes('-Command') &&
        args.some((arg) => arg.includes('Register-ScheduledTask'))
      ) {
        return commandResult(0);
      }

      if (
        command === 'powershell' &&
        args.includes('-Command') &&
        args.some((arg) => arg.includes("Get-ScheduledTask -TaskName 'KeygateGateway'"))
      ) {
        statusChecks += 1;
        if (statusChecks === 1) {
          return commandResult(0, 'State=Ready\nLastTaskResult=0\n');
        }
        return commandResult(0, 'State=Running\nLastTaskResult=0\n');
      }

      if (joined === 'schtasks /Run /TN KeygateGateway') {
        return commandResult(0, 'SUCCESS: Attempted to run the scheduled task.\n');
      }

      throw new Error(`Unexpected command: ${joined}`);
    });

    await runGatewayCommand(makeArgs('gateway', 'open'), {
      platform: 'win32',
      homeDir: 'C:\\Users\\tester',
      configDir: path.join('C:\\Users\\tester', 'AppData', 'Roaming', 'keygate'),
      runCommand,
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      chmod: vi.fn(async () => undefined),
      log: (line: string) => {
        logs.push(line);
      },
    });

    expect(
      runCommand.mock.calls.some(
        ([command, args]) =>
          command === 'schtasks' && Array.isArray(args) && args[0] === '/Run' && args[2] === 'KeygateGateway'
      )
    ).toBe(true);
    expect(logs.some((line) => line.includes('Gateway status: running'))).toBe(true);
  });
});
