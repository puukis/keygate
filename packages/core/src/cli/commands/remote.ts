import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import {
  getConfigDir,
  getConfigHomeDir,
  loadConfigFromEnv,
  savePersistedConfigObject,
} from '../../config/env.js';
import type { KeygateConfig } from '../../types.js';
import type { ParsedArgs } from '../argv.js';

export type RemoteTransport = 'tailscale' | 'ssh';
export type RemoteAction = 'start' | 'stop' | 'status' | 'restart' | 'url';
export type RemoteRuntimeState = 'running' | 'stopped' | 'unknown';

export interface RemoteRuntimeStatus {
  available: boolean;
  state: RemoteRuntimeState;
  detail: string;
  url?: string;
}

export interface SshRemoteStatus extends RemoteRuntimeStatus {
  profileComplete: boolean;
  localUrl: string;
}

export interface RemoteStatusSummary {
  bindHost: string;
  bindPort: number;
  authMode: KeygateConfig['remote']['authMode'];
  tailscale: RemoteRuntimeStatus;
  ssh: SshRemoteStatus;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | undefined;
}

interface SshManagerAdapter {
  ensureDefinition(): Promise<void>;
  open(): Promise<void>;
  close(): Promise<void>;
  status(): Promise<RemoteRuntimeStatus>;
}

export interface RemoteDeps {
  platform: NodeJS.Platform;
  uid: number | null;
  homeDir: string;
  configDir: string;
  configHomeDir: string;
  log: (message: string) => void;
  mkdir: (targetPath: string) => Promise<void>;
  writeFile: (targetPath: string, content: string) => Promise<void>;
  chmod: (targetPath: string, mode: number) => Promise<void>;
  readFile: (targetPath: string) => Promise<string>;
  runCommand: (command: string, args: string[], options?: { input?: string }) => CommandResult;
  pathExists: (targetPath: string) => boolean;
  sleep: (ms: number) => Promise<void>;
}

const REMOTE_USAGE = [
  'Usage:',
  '  keygate remote tailscale <start|stop|status|restart|url>',
  '  keygate remote ssh config --host <host> [--user <user>] [--port <port>] [--local-port <port>] [--remote-port <port>] [--identity-file <path>]',
  '  keygate remote ssh <start|stop|status|restart|url>',
].join('\n');
const TAILSCALE_USAGE = 'Usage: keygate remote tailscale <start|stop|status|restart|url>';
const SSH_USAGE = [
  'Usage:',
  '  keygate remote ssh config --host <host> [--user <user>] [--port <port>] [--local-port <port>] [--remote-port <port>] [--identity-file <path>]',
  '  keygate remote ssh <start|stop|status|restart|url>',
].join('\n');
const LINUX_SSH_UNIT_NAME = 'keygate-remote-ssh.service';
const MACOS_SSH_LABEL = 'dev.keygate.remote.ssh';
const TAILSCALE_HTTPS_PORT = 443;

export async function runRemoteCommand(
  args: ParsedArgs,
  depsOverride?: Partial<RemoteDeps>,
): Promise<void> {
  const transport = parseRemoteTransport(args.positional[1]);
  if (!transport) {
    throw new Error(REMOTE_USAGE);
  }

  const deps = createRemoteDeps(depsOverride);

  if (transport === 'tailscale') {
    const action = parseRemoteAction(args.positional[2]);
    if (!action) {
      throw new Error(TAILSCALE_USAGE);
    }

    await runTailscaleAction(loadConfigFromEnv(), action, deps);
    return;
  }

  const subcommand = args.positional[2];
  if (subcommand === 'config') {
    await runSshConfigCommand(loadConfigFromEnv(), args, deps);
    return;
  }

  const action = parseRemoteAction(subcommand);
  if (!action) {
    throw new Error(SSH_USAGE);
  }

  await runSshAction(loadConfigFromEnv(), action, deps);
}

export function parseRemoteTransport(value: string | undefined): RemoteTransport | null {
  if (value === 'tailscale' || value === 'ssh') {
    return value;
  }

  return null;
}

export function parseRemoteAction(value: string | undefined): RemoteAction | null {
  if (value === 'start' || value === 'stop' || value === 'status' || value === 'restart' || value === 'url') {
    return value;
  }

  return null;
}

export async function getRemoteStatusSummary(
  config: KeygateConfig = loadConfigFromEnv(),
  depsOverride?: Partial<RemoteDeps>,
): Promise<RemoteStatusSummary> {
  const deps = createRemoteDeps(depsOverride);
  const [tailscale, ssh] = await Promise.all([
    getTailscaleStatus(config, deps),
    getSshStatus(config, deps),
  ]);

  return {
    bindHost: config.server.host,
    bindPort: config.server.port,
    authMode: config.remote.authMode,
    tailscale,
    ssh,
  };
}

export function isSshProfileComplete(profile: KeygateConfig['remote']['ssh']): boolean {
  return typeof profile.host === 'string' && profile.host.trim().length > 0;
}

export function getSshLocalUrl(profile: KeygateConfig['remote']['ssh']): string {
  return `http://127.0.0.1:${profile.localPort}`;
}

export function buildSshCommandArgs(profile: KeygateConfig['remote']['ssh']): string[] {
  const destination = profile.user?.trim()
    ? `${profile.user.trim()}@${profile.host!.trim()}`
    : profile.host!.trim();
  const args = [
    '-N',
    '-L',
    `${profile.localPort}:127.0.0.1:${profile.remotePort}`,
    '-p',
    String(profile.port),
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'IdentitiesOnly=yes',
  ];

  if (profile.identityFile?.trim()) {
    args.push('-i', expandHomePath(profile.identityFile.trim()));
  }

  args.push(destination);
  return args;
}

async function runTailscaleAction(
  config: KeygateConfig,
  action: RemoteAction,
  deps: RemoteDeps,
): Promise<void> {
  assertRemotePlatformSupported(deps.platform);

  if (action === 'status') {
    printTailscaleStatus(deps, await getTailscaleStatus(config, deps));
    return;
  }

  if (action === 'url') {
    const status = await getTailscaleStatus(config, deps);
    if (status.state !== 'running' || !status.url) {
      throw new Error('Tailscale remote access is not running. Start it with `keygate remote tailscale start` first.');
    }
    deps.log(status.url);
    return;
  }

  if (action === 'start') {
    const before = await getTailscaleStatus(config, deps);
    if (before.state === 'running') {
      deps.log('Tailscale remote access is already running.');
      printTailscaleStatus(deps, before);
      return;
    }

    await ensureRemoteOperatorProtection(config, deps);
    runOrThrow(
      deps,
      'tailscale',
      ['serve', '--bg', '--yes', `--https=${TAILSCALE_HTTPS_PORT}`, `http://127.0.0.1:${config.server.port}`],
      'Failed to start Tailscale Serve',
    );
    deps.log('Tailscale remote access start requested.');
    printTailscaleStatus(deps, await getTailscaleStatus(config, deps));
    return;
  }

  if (action === 'restart') {
    await ensureRemoteOperatorProtection(config, deps);
    await stopTailscaleServe(config, deps);
    await deps.sleep(500);
    runOrThrow(
      deps,
      'tailscale',
      ['serve', '--bg', '--yes', `--https=${TAILSCALE_HTTPS_PORT}`, `http://127.0.0.1:${config.server.port}`],
      'Failed to restart Tailscale Serve',
    );
    deps.log('Tailscale remote access restart requested.');
    printTailscaleStatus(deps, await getTailscaleStatus(config, deps));
    return;
  }

  const before = await getTailscaleStatus(config, deps);
  if (before.state === 'stopped') {
    deps.log('Tailscale remote access is already stopped.');
    printTailscaleStatus(deps, before);
    return;
  }

  await stopTailscaleServe(config, deps);
  deps.log('Tailscale remote access stop requested.');
  printTailscaleStatus(deps, await getTailscaleStatus(config, deps));
}

async function runSshAction(
  config: KeygateConfig,
  action: RemoteAction,
  deps: RemoteDeps,
): Promise<void> {
  assertRemotePlatformSupported(deps.platform);
  const adapter = createSshAdapter(config, deps);

  if (action === 'status') {
    printSshStatus(deps, await getSshStatus(config, deps));
    return;
  }

  if (action === 'url') {
    const status = await getSshStatus(config, deps);
    if (status.state !== 'running') {
      throw new Error('SSH tunnel is not running. Start it with `keygate remote ssh start` first.');
    }
    deps.log(status.localUrl);
    return;
  }

  if (action === 'start') {
    const before = await getSshStatus(config, deps);
    if (before.state === 'running') {
      deps.log('SSH tunnel is already running.');
      printSshStatus(deps, before);
      return;
    }

    assertSshProfileUsable(config.remote.ssh);
    await ensureRemoteOperatorProtection(config, deps);
    await adapter.ensureDefinition();
    await adapter.open();
    const after = await settleSshStatus(adapter, deps.platform);
    deps.log('SSH tunnel start requested.');
    printSshStatus(deps, {
      ...after,
      profileComplete: true,
      localUrl: getSshLocalUrl(config.remote.ssh),
    });
    return;
  }

  if (action === 'restart') {
    assertSshProfileUsable(config.remote.ssh);
    await ensureRemoteOperatorProtection(config, deps);
    await adapter.ensureDefinition();
    await adapter.close();
    if (deps.platform === 'darwin') {
      await deps.sleep(800);
    }
    await adapter.open();
    const after = await settleSshStatus(adapter, deps.platform);
    deps.log('SSH tunnel restart requested.');
    printSshStatus(deps, {
      ...after,
      profileComplete: true,
      localUrl: getSshLocalUrl(config.remote.ssh),
    });
    return;
  }

  const before = await getSshStatus(config, deps);
  if (before.state === 'stopped') {
    deps.log('SSH tunnel is already stopped.');
    printSshStatus(deps, before);
    return;
  }

  await adapter.close();
  deps.log('SSH tunnel stop requested.');
  printSshStatus(deps, await getSshStatus(config, deps));
}

async function runSshConfigCommand(
  config: KeygateConfig,
  args: ParsedArgs,
  deps: RemoteDeps,
): Promise<void> {
  const current = config.remote.ssh;
  const next: KeygateConfig['remote']['ssh'] = {
    ...current,
  };
  let changed = false;

  if (typeof args.flags['host'] === 'string') {
    next.host = normalizeOptionalString(args.flags['host']);
    changed = true;
  }
  if (typeof args.flags['user'] === 'string') {
    next.user = normalizeOptionalString(args.flags['user']);
    changed = true;
  }
  if (typeof args.flags['identity-file'] === 'string') {
    const raw = args.flags['identity-file'].trim();
    next.identityFile = raw.length > 0 ? expandHomePath(raw) : undefined;
    changed = true;
  }
  if (typeof args.flags['port'] === 'string') {
    next.port = parseRequiredPort(args.flags['port'], '--port');
    changed = true;
  }
  if (typeof args.flags['local-port'] === 'string') {
    next.localPort = parseRequiredPort(args.flags['local-port'], '--local-port');
    changed = true;
  }
  if (typeof args.flags['remote-port'] === 'string') {
    next.remotePort = parseRequiredPort(args.flags['remote-port'], '--remote-port');
    changed = true;
  }

  if (!changed) {
    printSshProfile(deps, current);
    return;
  }

  await savePersistedConfigObject((root) => ({
    ...root,
    remote: {
      ...sanitizeObject(root['remote']),
      authMode: config.remote.authMode,
      tailscale: {
        ...sanitizeObject(sanitizeObject(root['remote'])['tailscale']),
        resetOnStop: config.remote.tailscale.resetOnStop,
      },
      ssh: serializeSshProfile(next),
    },
  }));

  config.remote.ssh = next;
  deps.log('Saved SSH tunnel profile.');
  printSshProfile(deps, next);
}

async function ensureRemoteOperatorProtection(
  config: KeygateConfig,
  deps: RemoteDeps,
): Promise<void> {
  let generatedToken: string | undefined;
  const authModeChanged = config.remote.authMode !== 'token';
  const needsToken = config.server.apiToken.trim().length === 0;

  if (!authModeChanged && !needsToken) {
    return;
  }

  const nextToken = needsToken ? crypto.randomBytes(24).toString('base64url') : config.server.apiToken.trim();
  if (needsToken) {
    generatedToken = nextToken;
  }

  await savePersistedConfigObject((root) => ({
    ...root,
    server: {
      ...sanitizeObject(root['server']),
      host: config.server.host,
      port: config.server.port,
      apiToken: nextToken,
    },
    remote: {
      ...sanitizeObject(root['remote']),
      authMode: 'token',
      tailscale: {
        ...sanitizeObject(sanitizeObject(root['remote'])['tailscale']),
        resetOnStop: config.remote.tailscale.resetOnStop,
      },
      ssh: serializeSshProfile(config.remote.ssh),
    },
  }));

  config.remote.authMode = 'token';
  config.server.apiToken = nextToken;

  if (authModeChanged) {
    deps.log('Enabled token-based operator auth for remote access.');
  }
  if (generatedToken) {
    deps.log(`Generated operator token: ${generatedToken}`);
  }
}

async function stopTailscaleServe(config: KeygateConfig, deps: RemoteDeps): Promise<void> {
  if (config.remote.tailscale.resetOnStop) {
    const result = deps.runCommand('tailscale', ['serve', 'reset']);
    if (result.status === 0) {
      return;
    }

    const message = commandOutput(result);
    if (isTailscaleServeStoppedMessage(message)) {
      return;
    }
    throw new Error(`Failed to reset Tailscale Serve: ${message}`);
  }

  const result = deps.runCommand('tailscale', ['serve', '--yes', `--https=${TAILSCALE_HTTPS_PORT}`, 'off']);
  if (result.status === 0) {
    return;
  }

  const message = commandOutput(result);
  if (isTailscaleServeStoppedMessage(message)) {
    return;
  }
  throw new Error(`Failed to stop Tailscale Serve: ${message}`);
}

async function getTailscaleStatus(
  config: KeygateConfig,
  deps: RemoteDeps,
): Promise<RemoteRuntimeStatus> {
  const binaryCheck = deps.runCommand('tailscale', ['version']);
  if (binaryCheck.error) {
    return {
      available: false,
      state: 'unknown',
      detail: 'tailscale CLI is not installed',
    };
  }

  const statusResult = deps.runCommand('tailscale', ['serve', 'status']);
  const output = commandOutput(statusResult);
  if (statusResult.status !== 0) {
    return {
      available: true,
      state: isTailscaleServeStoppedMessage(output) ? 'stopped' : 'unknown',
      detail: output,
    };
  }

  if (isTailscaleServeStoppedMessage(output)) {
    return {
      available: true,
      state: 'stopped',
      detail: output || 'Tailscale Serve is not configured',
    };
  }

  const url = await resolveTailscaleUrl(deps, output);
  const detail = output.trim().length > 0
    ? summarizeFirstLine(output)
    : `Serving https://${TAILSCALE_HTTPS_PORT} -> http://127.0.0.1:${config.server.port}`;

  return {
    available: true,
    state: 'running',
    detail,
    url,
  };
}

async function resolveTailscaleUrl(deps: RemoteDeps, statusOutput: string): Promise<string | undefined> {
  const direct = statusOutput.match(/https:\/\/[^\s)]+/i)?.[0];
  if (direct) {
    return direct.replace(/\/$/, '');
  }

  const statusJson = deps.runCommand('tailscale', ['status', '--json']);
  if (statusJson.status !== 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(statusJson.stdout) as Record<string, unknown>;
    const self = sanitizeObject(parsed['Self'] ?? parsed['self']);
    const dnsNameRaw = self['DNSName'] ?? self['dnsName'];
    if (typeof dnsNameRaw !== 'string' || dnsNameRaw.trim().length === 0) {
      return undefined;
    }
    return `https://${dnsNameRaw.trim().replace(/\.$/, '')}`;
  } catch {
    return undefined;
  }
}

async function getSshStatus(
  config: KeygateConfig,
  deps: RemoteDeps,
): Promise<SshRemoteStatus> {
  const localUrl = getSshLocalUrl(config.remote.ssh);
  if (!isSshProfileComplete(config.remote.ssh)) {
    return {
      available: true,
      state: 'stopped',
      detail: 'SSH profile is incomplete. Configure `remote.ssh.host` first.',
      profileComplete: false,
      localUrl,
    };
  }

  const sshCheck = deps.runCommand('ssh', ['-V']);
  if (sshCheck.error) {
    return {
      available: false,
      state: 'unknown',
      detail: 'ssh client is not installed',
      profileComplete: true,
      localUrl,
    };
  }

  try {
    const adapter = createSshAdapter(config, deps);
    const status = await adapter.status();
    return {
      ...status,
      profileComplete: true,
      localUrl,
      url: localUrl,
    };
  } catch (error) {
    return {
      available: false,
      state: 'unknown',
      detail: error instanceof Error ? error.message : 'SSH tunnel status unavailable',
      profileComplete: true,
      localUrl,
    };
  }
}

function createSshAdapter(config: KeygateConfig, deps: RemoteDeps): SshManagerAdapter {
  assertSshProfileUsable(config.remote.ssh);

  if (deps.platform === 'linux') {
    return createLinuxSshAdapter(config.remote.ssh, deps);
  }

  if (deps.platform === 'darwin') {
    return createMacOSSshAdapter(config.remote.ssh, deps);
  }

  throw unsupportedRemoteError(
    deps.platform,
    'Managed SSH tunnels are only implemented for macOS and Linux.',
  );
}

function createLinuxSshAdapter(
  profile: KeygateConfig['remote']['ssh'],
  deps: RemoteDeps,
): SshManagerAdapter {
  const runtimeDir = path.join(deps.configDir, 'remote', 'ssh');
  const launcherPath = path.join(runtimeDir, 'launch-ssh-tunnel.sh');
  const systemdUserDir = path.join(deps.configHomeDir, 'systemd', 'user');
  const unitPath = path.join(systemdUserDir, LINUX_SSH_UNIT_NAME);
  const launchSpec = { command: 'ssh', args: buildSshCommandArgs(profile) };

  return {
    async ensureDefinition() {
      assertLinuxManagerAvailable(deps);
      await deps.mkdir(runtimeDir);
      await deps.mkdir(systemdUserDir);
      await deps.writeFile(launcherPath, buildShellLauncherContent(launchSpec.command, launchSpec.args));
      await deps.chmod(launcherPath, 0o755);
      await deps.writeFile(unitPath, buildLinuxSshUnitContent(launcherPath));
      runOrThrow(
        deps,
        'systemctl',
        ['--user', 'daemon-reload'],
        'Failed to reload systemd user units for SSH tunnel',
      );
    },

    async open() {
      runOrThrow(
        deps,
        'systemctl',
        ['--user', 'start', LINUX_SSH_UNIT_NAME],
        'Failed to start SSH tunnel systemd unit',
      );
    },

    async close() {
      const result = deps.runCommand('systemctl', ['--user', 'stop', LINUX_SSH_UNIT_NAME]);
      if (result.status === 0) {
        return;
      }

      const message = commandOutput(result);
      if (isNotLoadedMessage(message)) {
        return;
      }

      throw new Error(`Failed to stop SSH tunnel systemd unit: ${message}`);
    },

    async status() {
      assertLinuxManagerAvailable(deps);
      const activeResult = deps.runCommand('systemctl', ['--user', 'is-active', LINUX_SSH_UNIT_NAME]);
      const activeValue = activeResult.stdout.trim().toLowerCase();
      const detailResult = deps.runCommand('systemctl', [
        '--user',
        'show',
        LINUX_SSH_UNIT_NAME,
        '--property=ActiveState,SubState,UnitFileState',
        '--value',
      ]);
      const detail = summarizeLinuxDetail(detailResult);

      if (activeResult.status === 0 && activeValue === 'active') {
        return { available: true, state: 'running', detail };
      }

      if (
        activeValue === 'inactive' ||
        activeValue === 'failed' ||
        activeValue === 'unknown' ||
        isNotLoadedMessage(commandOutput(activeResult))
      ) {
        return { available: true, state: 'stopped', detail };
      }

      return { available: true, state: 'unknown', detail };
    },
  };
}

function createMacOSSshAdapter(
  profile: KeygateConfig['remote']['ssh'],
  deps: RemoteDeps,
): SshManagerAdapter {
  const runtimeDir = path.join(deps.configDir, 'remote', 'ssh');
  const launcherPath = path.join(runtimeDir, 'launch-ssh-tunnel.sh');
  const launchAgentsDir = path.join(deps.homeDir, 'Library', 'LaunchAgents');
  const plistPath = path.join(launchAgentsDir, `${MACOS_SSH_LABEL}.plist`);
  const stdoutLogPath = path.join(runtimeDir, 'launchd.stdout.log');
  const stderrLogPath = path.join(runtimeDir, 'launchd.stderr.log');
  const domain = resolveLaunchdDomain(deps);
  const launchSpec = { command: 'ssh', args: buildSshCommandArgs(profile) };

  return {
    async ensureDefinition() {
      assertMacOSManagerAvailable(deps);
      await deps.mkdir(runtimeDir);
      await deps.mkdir(launchAgentsDir);
      await deps.writeFile(launcherPath, buildShellLauncherContent(launchSpec.command, launchSpec.args));
      await deps.chmod(launcherPath, 0o755);
      await deps.writeFile(
        plistPath,
        buildLaunchdPlistContent(MACOS_SSH_LABEL, launcherPath, stdoutLogPath, stderrLogPath),
      );
    },

    async open() {
      const bootstrap = deps.runCommand('launchctl', ['bootstrap', domain, plistPath]);
      if (bootstrap.status !== 0) {
        const message = commandOutput(bootstrap);
        if (!isLaunchdAlreadyLoadedMessage(message)) {
          deps.runCommand('launchctl', ['bootout', `${domain}/${MACOS_SSH_LABEL}`]);
          await deps.sleep(1000);
          const retry = deps.runCommand('launchctl', ['bootstrap', domain, plistPath]);
          if (retry.status !== 0) {
            const retryMessage = commandOutput(retry);
            if (!isLaunchdAlreadyLoadedMessage(retryMessage)) {
              throw new Error(`Failed to bootstrap SSH tunnel launchd service: ${retryMessage}`);
            }
          }
        }
      }

      runOrThrow(
        deps,
        'launchctl',
        ['kickstart', '-k', `${domain}/${MACOS_SSH_LABEL}`],
        'Failed to kickstart SSH tunnel launchd service',
      );
    },

    async close() {
      const result = deps.runCommand('launchctl', ['bootout', `${domain}/${MACOS_SSH_LABEL}`]);
      if (result.status === 0) {
        return;
      }

      const message = commandOutput(result);
      if (isLaunchdNotLoadedMessage(message)) {
        return;
      }

      throw new Error(`Failed to stop SSH tunnel launchd service: ${message}`);
    },

    async status() {
      assertMacOSManagerAvailable(deps);
      const result = deps.runCommand('launchctl', ['print', `${domain}/${MACOS_SSH_LABEL}`]);
      const output = commandOutput(result);
      if (result.status !== 0) {
        if (isLaunchdNotLoadedMessage(output)) {
          return { available: true, state: 'stopped', detail: 'launchd service is not loaded' };
        }
        return { available: true, state: 'unknown', detail: output };
      }

      const stateMatch = result.stdout.match(/state = ([a-zA-Z]+)/);
      const pidMatch = result.stdout.match(/pid = ([0-9]+)/);
      const activeCountMatch = result.stdout.match(/active count = ([0-9]+)/);

      const activeCount = activeCountMatch ? Number.parseInt(activeCountMatch[1]!, 10) : Number.NaN;
      if ((pidMatch || stateMatch?.[1]?.toLowerCase() === 'running') && (Number.isNaN(activeCount) || activeCount > 0)) {
        const pidSegment = pidMatch ? ` pid=${pidMatch[1]}` : '';
        return {
          available: true,
          state: 'running',
          detail: `launchd state=${stateMatch?.[1] ?? 'running'}${pidSegment}`,
        };
      }

      if (!Number.isNaN(activeCount) && activeCount === 0) {
        return {
          available: true,
          state: 'stopped',
          detail: `launchd state=${stateMatch?.[1] ?? 'inactive'} active_count=0`,
        };
      }

      return {
        available: true,
        state: 'unknown',
        detail: output.trim() || 'Unable to determine launchd state',
      };
    },
  };
}

async function settleSshStatus(
  adapter: SshManagerAdapter,
  platform: NodeJS.Platform,
): Promise<RemoteRuntimeStatus> {
  const first = await adapter.status();
  if (platform !== 'darwin' || first.state !== 'running') {
    return first;
  }
  await new Promise((resolve) => setTimeout(resolve, 700));
  return adapter.status();
}

function assertSshProfileUsable(profile: KeygateConfig['remote']['ssh']): void {
  if (!isSshProfileComplete(profile)) {
    throw new Error(
      'SSH profile is incomplete. Configure it with `keygate remote ssh config --host <host> ...` first.',
    );
  }
}

function printTailscaleStatus(deps: RemoteDeps, status: RemoteRuntimeStatus): void {
  deps.log(`Tailscale remote status: ${status.state}`);
  deps.log(`Detail: ${status.detail}`);
  if (status.url) {
    deps.log(`URL: ${status.url}`);
  }
}

function printSshStatus(deps: RemoteDeps, status: SshRemoteStatus): void {
  deps.log(`SSH tunnel status: ${status.state}`);
  deps.log(`Detail: ${status.detail}`);
  deps.log(`Profile: ${status.profileComplete ? 'configured' : 'incomplete'}`);
  deps.log(`Local URL: ${status.localUrl}`);
}

function printSshProfile(deps: RemoteDeps, profile: KeygateConfig['remote']['ssh']): void {
  deps.log('SSH tunnel profile:');
  deps.log(`Host: ${profile.host?.trim() || 'not set'}`);
  deps.log(`User: ${profile.user?.trim() || 'not set'}`);
  deps.log(`Port: ${profile.port}`);
  deps.log(`Local port: ${profile.localPort}`);
  deps.log(`Remote port: ${profile.remotePort}`);
  deps.log(`Identity file: ${profile.identityFile?.trim() || 'ssh-agent / default keys'}`);
  deps.log(`Local URL: ${getSshLocalUrl(profile)}`);
}

function createRemoteDeps(overrides?: Partial<RemoteDeps>): RemoteDeps {
  const defaults: RemoteDeps = {
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    homeDir: os.homedir(),
    configDir: getConfigDir(),
    configHomeDir: getConfigHomeDir(),
    log: (message: string) => {
      console.log(message);
    },
    mkdir: async (targetPath: string) => {
      await fs.mkdir(targetPath, { recursive: true });
    },
    writeFile: async (targetPath: string, content: string) => {
      await fs.writeFile(targetPath, content, 'utf8');
    },
    chmod: async (targetPath: string, mode: number) => {
      await fs.chmod(targetPath, mode);
    },
    readFile: async (targetPath: string) => fs.readFile(targetPath, 'utf8'),
    runCommand: (command: string, commandArgs: string[], options?: { input?: string }) => runSync(command, commandArgs, options),
    pathExists: (targetPath: string) => existsSync(targetPath),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  };

  if (!overrides) {
    return defaults;
  }

  return {
    ...defaults,
    ...overrides,
  };
}

function buildShellLauncherContent(command: string, args: string[]): string {
  return [
    '#!/bin/sh',
    'set -eu',
    `exec ${toShellCommand(command, args)}`,
    '',
  ].join('\n');
}

function buildLinuxSshUnitContent(launcherPath: string): string {
  return [
    '[Unit]',
    'Description=Keygate SSH Tunnel',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${launcherPath}`,
    'Restart=on-failure',
    'RestartSec=2',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function buildLaunchdPlistContent(
  label: string,
  launcherPath: string,
  stdoutLogPath: string,
  stderrLogPath: string,
): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/sh</string>',
    `    <string>${escapeXml(launcherPath)}</string>`,
    '  </array>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(stdoutLogPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(stderrLogPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function assertRemotePlatformSupported(platform: NodeJS.Platform): void {
  if (platform === 'darwin' || platform === 'linux') {
    return;
  }

  throw unsupportedRemoteError(
    platform,
    'Remote access helpers are only implemented for macOS and Linux in v1.',
  );
}

function assertLinuxManagerAvailable(deps: RemoteDeps): void {
  const systemctlCheck = deps.runCommand('systemctl', ['--version']);
  if (systemctlCheck.error) {
    throw unsupportedRemoteError('linux', 'systemctl is not available.');
  }

  const result = deps.runCommand('systemctl', ['--user', 'show-environment']);
  if (result.error || result.status !== 0) {
    const message = commandOutput(result);
    throw unsupportedRemoteError(
      'linux',
      `systemd --user is not available in this session${message ? ` (${message})` : ''}.`,
    );
  }
}

function assertMacOSManagerAvailable(deps: RemoteDeps): void {
  const launchctlCheck = deps.runCommand('launchctl', ['help']);
  if (launchctlCheck.error) {
    throw unsupportedRemoteError('darwin', 'launchctl is not available.');
  }
  if (deps.uid === null) {
    throw unsupportedRemoteError('darwin', 'Unable to determine current user id (uid).');
  }
}

function resolveLaunchdDomain(deps: RemoteDeps): string {
  if (deps.uid === null) {
    throw unsupportedRemoteError('darwin', 'Unable to determine current user id (uid) for launchd domain.');
  }
  return `gui/${deps.uid}`;
}

function sanitizeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function serializeSshProfile(profile: KeygateConfig['remote']['ssh']): Record<string, unknown> {
  return {
    ...(profile.host?.trim() ? { host: profile.host.trim() } : {}),
    ...(profile.user?.trim() ? { user: profile.user.trim() } : {}),
    port: profile.port,
    localPort: profile.localPort,
    remotePort: profile.remotePort,
    ...(profile.identityFile?.trim() ? { identityFile: profile.identityFile.trim() } : {}),
  };
}

function parseRequiredPort(value: string, flagName: string): number {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  return parsed;
}

function normalizeOptionalString(value: string): string | undefined {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function expandHomePath(value: string): string {
  if (value === '~') {
    return os.homedir();
  }

  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

function summarizeFirstLine(value: string): string {
  return value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?? 'No details available';
}

function runOrThrow(
  deps: RemoteDeps,
  command: string,
  args: string[],
  failurePrefix: string,
  options?: { input?: string },
): void {
  const result = deps.runCommand(command, args, options);
  if (result.status === 0) {
    return;
  }

  throw new Error(`${failurePrefix}: ${commandOutput(result)}`);
}

function summarizeLinuxDetail(result: CommandResult): string {
  if (result.status !== 0) {
    return commandOutput(result);
  }

  const parts = result.stdout
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (parts.length >= 3) {
    return `active=${parts[0]}, sub=${parts[1]}, unitFile=${parts[2]}`;
  }

  if (parts.length > 0) {
    return parts.join(', ');
  }

  return 'systemd unit status unavailable';
}

function commandOutput(result: CommandResult): string {
  if (result.error?.message) {
    return result.error.message;
  }

  const combined = `${result.stdout}\n${result.stderr}`.trim();
  if (combined.length > 0) {
    return combined;
  }

  return `exit code ${result.status ?? 'unknown'}`;
}

function isNotLoadedMessage(message: string): boolean {
  return /not loaded|not-found|could not be found|no such file|unknown unit/i.test(message);
}

function isLaunchdAlreadyLoadedMessage(message: string): boolean {
  return /service already loaded|already bootstrapped|in progress/i.test(message);
}

function isLaunchdNotLoadedMessage(message: string): boolean {
  return /could not find service|service not found|no such process|does not exist|not loaded/i.test(message);
}

function isTailscaleServeStoppedMessage(message: string): boolean {
  return /nothing served|not serving|no serve config|serve is off|not configured/i.test(message);
}

function unsupportedRemoteError(platform: NodeJS.Platform | string, reason: string): Error {
  return new Error(`Remote access helpers are unavailable on ${platform}: ${reason}`);
}

function toShellCommand(command: string, args: string[]): string {
  return [shellQuote(command), ...args.map((arg) => shellQuote(arg))].join(' ');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function runSync(command: string, args: string[], options?: { input?: string }): CommandResult {
  const spawnOptions: SpawnSyncOptions = {
    encoding: 'utf8',
    input: options?.input,
  };
  const result = spawnSync(command, args, spawnOptions);
  return {
    status: result.status,
    stdout: (result.stdout ?? '').toString(),
    stderr: (result.stderr ?? '').toString(),
    error: result.error,
  };
}
