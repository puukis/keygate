import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getConfigDir,
  getConfigHomeDir,
  getPersistedConfigPath,
  loadConfigFromEnv,
} from '../../config/env.js';
import {
  buildSshCommandArgs,
  parseRemoteAction,
  parseRemoteTransport,
  runRemoteCommand,
} from '../commands/remote.js';
import type { ParsedArgs } from '../argv.js';

function commandResult(
  status: number | null,
  stdout = '',
  stderr = '',
  error?: Error,
): { status: number | null; stdout: string; stderr: string; error: Error | undefined } {
  return {
    status,
    stdout,
    stderr,
    error,
  };
}

function makeArgs(
  positional: string[],
  flags: Record<string, string | boolean> = {},
): ParsedArgs {
  return {
    positional,
    flags,
  };
}

describe('remote CLI', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-remote-'));

    if (process.platform === 'win32') {
      vi.stubEnv('USERPROFILE', tempHome);
      vi.stubEnv('APPDATA', path.join(tempHome, 'AppData', 'Roaming'));
      return;
    }

    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(tempHome, '.config'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('parses remote transport and action values', () => {
    expect(parseRemoteTransport('tailscale')).toBe('tailscale');
    expect(parseRemoteTransport('ssh')).toBe('ssh');
    expect(parseRemoteTransport('nope')).toBeNull();

    expect(parseRemoteAction('start')).toBe('start');
    expect(parseRemoteAction('stop')).toBe('stop');
    expect(parseRemoteAction('status')).toBe('status');
    expect(parseRemoteAction('restart')).toBe('restart');
    expect(parseRemoteAction('url')).toBe('url');
    expect(parseRemoteAction('open')).toBeNull();
  });

  it('builds SSH command args with key-only defaults and expanded identity file paths', () => {
    const args = buildSshCommandArgs({
      host: 'gateway.example.com',
      user: 'ops',
      port: 2222,
      localPort: 28790,
      remotePort: 18790,
      identityFile: '~/.ssh/id_ed25519',
    });

    expect(args).toContain('-N');
    expect(args).toContain('28790:127.0.0.1:18790');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('ExitOnForwardFailure=yes');
    expect(args).toContain(path.join(tempHome, '.ssh', 'id_ed25519'));
    expect(args.at(-1)).toBe('ops@gateway.example.com');
  });

  it('persists the SSH profile from `remote ssh config`', async () => {
    const logs: string[] = [];

    await runRemoteCommand(
      makeArgs(['remote', 'ssh', 'config'], {
        host: 'gateway.example.com',
        user: 'ops',
        port: '2222',
        'local-port': '28791',
        'remote-port': '18791',
        'identity-file': '~/.ssh/id_ed25519',
      }),
      {
        log: (message) => {
          logs.push(message);
        },
      },
    );

    const config = loadConfigFromEnv();

    expect(config.remote.ssh).toEqual({
      host: 'gateway.example.com',
      user: 'ops',
      port: 2222,
      localPort: 28791,
      remotePort: 18791,
      identityFile: path.join(tempHome, '.ssh', 'id_ed25519'),
    });
    expect(logs.some((message) => message.includes('Saved SSH tunnel profile.'))).toBe(true);
    expect(logs.some((message) => message.includes('Local URL: http://127.0.0.1:28791'))).toBe(true);
  });

  it('starts Tailscale remote access, enables token auth, and prints the remote URL', async () => {
    await fs.mkdir(getConfigDir(), { recursive: true });
    await fs.writeFile(getPersistedConfigPath(), JSON.stringify({
      server: {
        host: '127.0.0.1',
        port: 18790,
        apiToken: '',
      },
      remote: {
        authMode: 'off',
        tailscale: {
          resetOnStop: false,
        },
      },
    }, null, 2));

    const logs: string[] = [];
    let serving = false;
    const runCommand = vi.fn((command: string, args: string[]) => {
      const joined = `${command} ${args.join(' ')}`;

      if (joined === 'tailscale version') {
        return commandResult(0, '1.80.0\n');
      }

      if (joined === 'tailscale serve status') {
        return serving
          ? commandResult(0, 'https://keygate.tail123.ts.net -> http://127.0.0.1:18790\n')
          : commandResult(0, 'Nothing served\n');
      }

      if (joined === 'tailscale serve --bg --yes --https=443 http://127.0.0.1:18790') {
        serving = true;
        return commandResult(0);
      }

      throw new Error(`Unexpected command: ${joined}`);
    });

    await runRemoteCommand(makeArgs(['remote', 'tailscale', 'start']), {
      platform: 'darwin',
      uid: 501,
      homeDir: tempHome,
      configDir: getConfigDir(),
      configHomeDir: getConfigHomeDir(),
      log: (message) => {
        logs.push(message);
      },
      runCommand,
      sleep: async () => undefined,
    });

    const config = loadConfigFromEnv();

    expect(config.remote.authMode).toBe('token');
    expect(config.server.apiToken.length).toBeGreaterThan(0);
    expect(logs.some((message) => message.includes('Enabled token-based operator auth'))).toBe(true);
    expect(logs.some((message) => message.includes('Generated operator token:'))).toBe(true);
    expect(logs.some((message) => message.includes('Tailscale remote status: running'))).toBe(true);
    expect(logs.some((message) => message.includes('URL: https://keygate.tail123.ts.net'))).toBe(true);

    const urlLogs: string[] = [];
    await runRemoteCommand(makeArgs(['remote', 'tailscale', 'url']), {
      platform: 'darwin',
      uid: 501,
      homeDir: tempHome,
      configDir: getConfigDir(),
      configHomeDir: getConfigHomeDir(),
      log: (message) => {
        urlLogs.push(message);
      },
      runCommand,
      sleep: async () => undefined,
    });

    expect(urlLogs).toEqual(['https://keygate.tail123.ts.net']);
  });

  it('stops Tailscale remote access with a full reset when configured', async () => {
    await fs.mkdir(getConfigDir(), { recursive: true });
    await fs.writeFile(getPersistedConfigPath(), JSON.stringify({
      server: {
        host: '127.0.0.1',
        port: 18790,
        apiToken: 'existing-token',
      },
      remote: {
        authMode: 'token',
        tailscale: {
          resetOnStop: true,
        },
      },
    }, null, 2));

    const logs: string[] = [];
    let serving = true;
    const runCommand = vi.fn((command: string, args: string[]) => {
      const joined = `${command} ${args.join(' ')}`;

      if (joined === 'tailscale version') {
        return commandResult(0, '1.80.0\n');
      }

      if (joined === 'tailscale serve status') {
        return serving
          ? commandResult(0, 'https://keygate.tail123.ts.net -> http://127.0.0.1:18790\n')
          : commandResult(0, 'Nothing served\n');
      }

      if (joined === 'tailscale serve reset') {
        serving = false;
        return commandResult(0);
      }

      throw new Error(`Unexpected command: ${joined}`);
    });

    await runRemoteCommand(makeArgs(['remote', 'tailscale', 'stop']), {
      platform: 'linux',
      uid: 501,
      homeDir: tempHome,
      configDir: getConfigDir(),
      configHomeDir: getConfigHomeDir(),
      log: (message) => {
        logs.push(message);
      },
      runCommand,
      sleep: async () => undefined,
    });

    expect(runCommand).toHaveBeenCalledWith('tailscale', ['serve', 'reset']);
    expect(logs.some((message) => message.includes('Tailscale remote status: stopped'))).toBe(true);
  });

  it('starts and stops the managed SSH tunnel and exposes the local forwarded URL', async () => {
    await fs.mkdir(getConfigDir(), { recursive: true });
    await fs.writeFile(getPersistedConfigPath(), JSON.stringify({
      server: {
        host: '127.0.0.1',
        port: 18790,
        apiToken: '',
      },
      remote: {
        authMode: 'off',
        tailscale: {
          resetOnStop: false,
        },
        ssh: {
          host: 'gateway.example.com',
          user: 'ops',
          port: 22,
          localPort: 28790,
          remotePort: 18790,
          identityFile: '~/.ssh/id_ed25519',
        },
      },
    }, null, 2));

    const logs: string[] = [];
    let active = false;
    const runCommand = vi.fn((command: string, args: string[]) => {
      const joined = `${command} ${args.join(' ')}`;

      if (joined === 'ssh -V') {
        return commandResult(0, '', 'OpenSSH_9.8p1\n');
      }

      if (joined === 'systemctl --version') {
        return commandResult(0, 'systemd 255\n');
      }

      if (joined === 'systemctl --user show-environment') {
        return commandResult(0, 'PATH=/usr/bin\n');
      }

      if (joined === 'systemctl --user daemon-reload') {
        return commandResult(0);
      }

      if (joined === 'systemctl --user start keygate-remote-ssh.service') {
        active = true;
        return commandResult(0);
      }

      if (joined === 'systemctl --user stop keygate-remote-ssh.service') {
        active = false;
        return commandResult(0);
      }

      if (joined === 'systemctl --user is-active keygate-remote-ssh.service') {
        return active
          ? commandResult(0, 'active\n')
          : commandResult(3, 'inactive\n');
      }

      if (joined === 'systemctl --user show keygate-remote-ssh.service --property=ActiveState,SubState,UnitFileState --value') {
        return active
          ? commandResult(0, 'active\nrunning\nenabled\n')
          : commandResult(0, 'inactive\ndead\ndisabled\n');
      }

      throw new Error(`Unexpected command: ${joined}`);
    });

    await runRemoteCommand(makeArgs(['remote', 'ssh', 'start']), {
      platform: 'linux',
      uid: 501,
      homeDir: tempHome,
      configDir: getConfigDir(),
      configHomeDir: getConfigHomeDir(),
      log: (message) => {
        logs.push(message);
      },
      runCommand,
      sleep: async () => undefined,
    });

    const config = loadConfigFromEnv();
    const launcherPath = path.join(getConfigDir(), 'remote', 'ssh', 'launch-ssh-tunnel.sh');
    const unitPath = path.join(getConfigHomeDir(), 'systemd', 'user', 'keygate-remote-ssh.service');
    const launcherContent = await fs.readFile(launcherPath, 'utf8');
    const unitContent = await fs.readFile(unitPath, 'utf8');

    expect(config.remote.authMode).toBe('token');
    expect(config.server.apiToken.length).toBeGreaterThan(0);
    expect(launcherContent).toContain('28790:127.0.0.1:18790');
    expect(launcherContent).toContain('BatchMode=yes');
    expect(unitContent).toContain('Description=Keygate SSH Tunnel');
    expect(logs.some((message) => message.includes('SSH tunnel status: running'))).toBe(true);
    expect(logs.some((message) => message.includes('Local URL: http://127.0.0.1:28790'))).toBe(true);

    const urlLogs: string[] = [];
    await runRemoteCommand(makeArgs(['remote', 'ssh', 'url']), {
      platform: 'linux',
      uid: 501,
      homeDir: tempHome,
      configDir: getConfigDir(),
      configHomeDir: getConfigHomeDir(),
      log: (message) => {
        urlLogs.push(message);
      },
      runCommand,
      sleep: async () => undefined,
    });

    expect(urlLogs).toEqual(['http://127.0.0.1:28790']);

    const stopLogs: string[] = [];
    await runRemoteCommand(makeArgs(['remote', 'ssh', 'stop']), {
      platform: 'linux',
      uid: 501,
      homeDir: tempHome,
      configDir: getConfigDir(),
      configHomeDir: getConfigHomeDir(),
      log: (message) => {
        stopLogs.push(message);
      },
      runCommand,
      sleep: async () => undefined,
    });

    expect(stopLogs.some((message) => message.includes('SSH tunnel status: stopped'))).toBe(true);
  });
});
