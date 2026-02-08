import os from 'node:os';
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { getConfigDir, getConfigHomeDir } from '../../config/env.js';
import type { ParsedArgs } from '../argv.js';

export type GatewayAction = 'open' | 'close' | 'status' | 'restart';
export type GatewayState = 'running' | 'stopped' | 'unknown';

export interface GatewayStatus {
  state: GatewayState;
  detail: string;
}

export interface GatewayManagerAdapter {
  ensureDefinition(): Promise<void>;
  open(): Promise<void>;
  close(): Promise<void>;
  status(): Promise<GatewayStatus>;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | undefined;
}

export interface GatewayDeps {
  platform: NodeJS.Platform;
  uid: number | null;
  cwd: string;
  homeDir: string;
  configDir: string;
  configHomeDir: string;
  envPath: string | undefined;
  envPathExt: string | undefined;
  envCodexBin: string | undefined;
  argv1: string | undefined;
  execPath: string;
  log: (message: string) => void;
  mkdir: (targetPath: string) => Promise<void>;
  writeFile: (targetPath: string, content: string) => Promise<void>;
  chmod: (targetPath: string, mode: number) => Promise<void>;
  runCommand: (command: string, args: string[], options?: { input?: string }) => CommandResult;
}

export interface ServeLaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

const LINUX_UNIT_NAME = 'keygate-gateway.service';
const MACOS_LABEL = 'dev.keygate.gateway';
const WINDOWS_TASK_NAME = 'KeygateGateway';

const GATEWAY_USAGE = 'Usage: keygate gateway <open|close|status|restart>';

export async function runGatewayCommand(
  args: ParsedArgs,
  depsOverride?: Partial<GatewayDeps>
): Promise<void> {
  const action = parseGatewayAction(args.positional[1]);
  if (!action) {
    throw new Error(GATEWAY_USAGE);
  }

  const deps = createGatewayDeps(depsOverride);
  const adapter = createGatewayAdapter(deps.platform, deps);

  if (action === 'status') {
    const current = await adapter.status();
    printGatewayStatus(deps, current);
    return;
  }

  await adapter.ensureDefinition();

  if (action === 'restart') {
    await adapter.close();
    await adapter.open();
    const after = await adapter.status();
    deps.log('Gateway restart requested.');
    printGatewayStatus(deps, after);
    return;
  }

  if (action === 'open') {
    const before = await adapter.status();
    if (before.state === 'running') {
      deps.log('Gateway is already running.');
      printGatewayStatus(deps, before);
      return;
    }

    await adapter.open();
    const after = await adapter.status();
    deps.log('Gateway open requested.');
    printGatewayStatus(deps, after);
    return;
  }

  const before = await adapter.status();
  if (before.state === 'stopped') {
    deps.log('Gateway is already stopped.');
    printGatewayStatus(deps, before);
    return;
  }

  await adapter.close();
  const after = await adapter.status();
  deps.log('Gateway close requested.');
  printGatewayStatus(deps, after);
}

export function parseGatewayAction(value: string | undefined): GatewayAction | null {
  if (value === 'open' || value === 'close' || value === 'status' || value === 'restart') {
    return value;
  }

  return null;
}

export function createGatewayAdapter(platform: NodeJS.Platform, deps: GatewayDeps): GatewayManagerAdapter {
  if (platform === 'linux') {
    return createLinuxAdapter(deps);
  }

  if (platform === 'darwin') {
    return createMacOSAdapter(deps);
  }

  if (platform === 'win32') {
    return createWindowsAdapter(deps);
  }

  throw unsupportedManagerError(
    platform,
    `Unsupported platform "${platform}" for native gateway lifecycle management.`
  );
}

function createGatewayDeps(overrides?: Partial<GatewayDeps>): GatewayDeps {
  const defaults: GatewayDeps = {
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    cwd: process.cwd(),
    homeDir: os.homedir(),
    configDir: getConfigDir(),
    configHomeDir: getConfigHomeDir(),
    envPath: process.env['PATH'],
    envPathExt: process.env['PATHEXT'],
    envCodexBin: process.env['KEYGATE_CODEX_BIN'],
    argv1: process.argv[1],
    execPath: process.execPath,
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
    runCommand: (command: string, args: string[], options?: { input?: string }) =>
      runSync(command, args, options),
  };

  if (!overrides) {
    return defaults;
  }

  return {
    ...defaults,
    ...overrides,
  };
}

function createLinuxAdapter(deps: GatewayDeps): GatewayManagerAdapter {
  const runtimeDir = path.join(deps.configDir, 'gateway');
  const launcherPath = path.join(runtimeDir, 'launch-keygate.sh');
  const systemdUserDir = path.join(deps.configHomeDir, 'systemd', 'user');
  const unitPath = path.join(systemdUserDir, LINUX_UNIT_NAME);
  const launchSpec = resolveServeLaunchSpec(deps);

  return {
    async ensureDefinition() {
      assertLinuxManagerAvailable(deps);
      await deps.mkdir(runtimeDir);
      await deps.mkdir(systemdUserDir);
      await deps.writeFile(launcherPath, buildShellLauncherContent(launchSpec));
      await deps.chmod(launcherPath, 0o755);
      await deps.writeFile(unitPath, buildLinuxUnitContent(launcherPath));
      runOrThrow(
        deps,
        'systemctl',
        ['--user', 'daemon-reload'],
        'Failed to reload systemd user units'
      );
    },

    async open() {
      runOrThrow(
        deps,
        'systemctl',
        ['--user', 'start', LINUX_UNIT_NAME],
        'Failed to start gateway systemd unit'
      );
    },

    async close() {
      const result = deps.runCommand('systemctl', ['--user', 'stop', LINUX_UNIT_NAME]);
      if (result.status === 0) {
        return;
      }

      const message = commandOutput(result);
      if (isNotLoadedMessage(message)) {
        return;
      }

      throw new Error(`Failed to stop gateway systemd unit: ${message}`);
    },

    async status() {
      assertLinuxManagerAvailable(deps);
      const activeResult = deps.runCommand('systemctl', ['--user', 'is-active', LINUX_UNIT_NAME]);
      const activeValue = activeResult.stdout.trim().toLowerCase();

      const detailResult = deps.runCommand('systemctl', [
        '--user',
        'show',
        LINUX_UNIT_NAME,
        '--property=ActiveState,SubState,UnitFileState',
        '--value',
      ]);
      const detail = summarizeLinuxDetail(detailResult);

      if (activeResult.status === 0 && activeValue === 'active') {
        return { state: 'running', detail };
      }

      if (
        activeValue === 'inactive' ||
        activeValue === 'failed' ||
        activeValue === 'unknown' ||
        isNotLoadedMessage(commandOutput(activeResult))
      ) {
        return { state: 'stopped', detail };
      }

      return { state: 'unknown', detail };
    },
  };
}

function createMacOSAdapter(deps: GatewayDeps): GatewayManagerAdapter {
  const runtimeDir = path.join(deps.configDir, 'gateway');
  const launcherPath = path.join(runtimeDir, 'launch-keygate.sh');
  const launchAgentsDir = path.join(deps.homeDir, 'Library', 'LaunchAgents');
  const plistPath = path.join(launchAgentsDir, `${MACOS_LABEL}.plist`);
  const domain = resolveLaunchdDomain(deps);
  const launchSpec = resolveServeLaunchSpec(deps);

  return {
    async ensureDefinition() {
      assertMacOSManagerAvailable(deps);
      await deps.mkdir(runtimeDir);
      await deps.mkdir(launchAgentsDir);
      await deps.writeFile(launcherPath, buildShellLauncherContent(launchSpec));
      await deps.chmod(launcherPath, 0o755);
      await deps.writeFile(plistPath, buildLaunchdPlistContent(launcherPath));
    },

    async open() {
      const bootstrap = deps.runCommand('launchctl', ['bootstrap', domain, plistPath]);
      if (bootstrap.status !== 0) {
        const message = commandOutput(bootstrap);
        if (!isLaunchdAlreadyLoadedMessage(message)) {
          throw new Error(`Failed to bootstrap launchd service: ${message}`);
        }
      }

      runOrThrow(
        deps,
        'launchctl',
        ['kickstart', '-k', `${domain}/${MACOS_LABEL}`],
        'Failed to kickstart launchd service'
      );
    },

    async close() {
      const result = deps.runCommand('launchctl', ['bootout', `${domain}/${MACOS_LABEL}`]);
      if (result.status === 0) {
        return;
      }

      const message = commandOutput(result);
      if (isLaunchdNotLoadedMessage(message)) {
        return;
      }

      throw new Error(`Failed to stop launchd service: ${message}`);
    },

    async status() {
      assertMacOSManagerAvailable(deps);
      const result = deps.runCommand('launchctl', ['print', `${domain}/${MACOS_LABEL}`]);
      const output = commandOutput(result);

      if (result.status !== 0) {
        if (isLaunchdNotLoadedMessage(output)) {
          return { state: 'stopped', detail: 'launchd service is not loaded' };
        }
        return { state: 'unknown', detail: output };
      }

      const stateMatch = result.stdout.match(/state = ([a-zA-Z]+)/);
      const pidMatch = result.stdout.match(/pid = ([0-9]+)/);

      if (pidMatch || stateMatch?.[1]?.toLowerCase() === 'running') {
        const pidSegment = pidMatch ? ` pid=${pidMatch[1]}` : '';
        return {
          state: 'running',
          detail: `launchd state=${stateMatch?.[1] ?? 'running'}${pidSegment}`,
        };
      }

      if (stateMatch?.[1]?.toLowerCase() === 'waiting') {
        return {
          state: 'stopped',
          detail: `launchd state=${stateMatch[1]}`,
        };
      }

      return {
        state: 'unknown',
        detail: output.trim() || 'Unable to determine launchd state',
      };
    },
  };
}

function createWindowsAdapter(deps: GatewayDeps): GatewayManagerAdapter {
  const runtimeDir = path.join(deps.configDir, 'gateway');
  const launcherPath = path.join(runtimeDir, 'launch-keygate.ps1');
  const launchSpec = resolveServeLaunchSpec(deps);
  const powershell = resolvePowerShellCommand(deps);

  return {
    async ensureDefinition() {
      assertWindowsManagerAvailable(deps, powershell);
      await deps.mkdir(runtimeDir);
      await deps.writeFile(launcherPath, buildPowerShellLauncherContent(launchSpec));

      const registerScript = [
        `$runner = '${escapePowerShellString(launcherPath)}'`,
        "$taskName = 'KeygateGateway'",
        "$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"' + $runner + '\"')",
        "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 0)",
        "Register-ScheduledTask -TaskName $taskName -Action $action -Settings $settings -Description 'Keygate gateway background service' -Force | Out-Null",
      ].join('; ');

      runOrThrow(
        deps,
        powershell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', registerScript],
        'Failed to register scheduled task for Keygate gateway'
      );
    },

    async open() {
      const result = deps.runCommand('schtasks', ['/Run', '/TN', WINDOWS_TASK_NAME]);
      if (result.status === 0) {
        return;
      }

      const message = commandOutput(result);
      if (/already running/i.test(message)) {
        return;
      }

      throw new Error(`Failed to run scheduled task "${WINDOWS_TASK_NAME}": ${message}`);
    },

    async close() {
      const result = deps.runCommand('schtasks', ['/End', '/TN', WINDOWS_TASK_NAME]);
      if (result.status === 0) {
        return;
      }

      const message = commandOutput(result);
      if (isWindowsTaskMissingOrStoppedMessage(message)) {
        return;
      }

      throw new Error(`Failed to stop scheduled task "${WINDOWS_TASK_NAME}": ${message}`);
    },

    async status() {
      assertWindowsManagerAvailable(deps, powershell);

      const script = [
        "$task = Get-ScheduledTask -TaskName 'KeygateGateway' -ErrorAction Stop",
        "$info = Get-ScheduledTaskInfo -TaskName 'KeygateGateway' -ErrorAction Stop",
        'Write-Output ("State=" + $task.State)',
        'Write-Output ("LastTaskResult=" + $info.LastTaskResult)',
      ].join('; ');

      const result = deps.runCommand(powershell, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ]);

      const output = commandOutput(result);
      if (result.status !== 0) {
        if (isWindowsTaskMissingOrStoppedMessage(output)) {
          return { state: 'stopped', detail: 'scheduled task does not exist or is not running' };
        }
        return { state: 'unknown', detail: output };
      }

      const state = extractKeyValue(result.stdout, 'State')?.toLowerCase();
      const lastTaskResult = extractKeyValue(result.stdout, 'LastTaskResult') ?? 'unknown';
      const detail = `state=${state ?? 'unknown'}, lastResult=${lastTaskResult}`;

      if (state === 'running') {
        return { state: 'running', detail };
      }

      if (state === 'ready' || state === 'disabled') {
        return { state: 'stopped', detail };
      }

      return { state: 'unknown', detail };
    },
  };
}

function resolveServeLaunchSpec(deps: GatewayDeps): ServeLaunchSpec {
  const env: Record<string, string> = {};
  const inheritedPath = deps.envPath?.trim();
  if (inheritedPath) {
    env['PATH'] = inheritedPath;
  }

  const codexBin = resolveCodexBinary(deps);
  if (codexBin) {
    env['KEYGATE_CODEX_BIN'] = codexBin;
  }

  const entry = deps.argv1?.trim();
  if (entry && entry.length > 0) {
    return {
      command: deps.execPath,
      args: [path.resolve(entry), 'serve'],
      env,
    };
  }

  return {
    command: 'keygate',
    args: ['serve'],
    env,
  };
}

export function buildShellLauncherContent(spec: ServeLaunchSpec): string {
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'export KEYGATE_OPEN_CHAT_ON_START=false',
  ];

  if (spec.env['PATH']) {
    lines.push(`export PATH=${shellQuote(spec.env['PATH'])}`);
  }

  if (spec.env['KEYGATE_CODEX_BIN']) {
    lines.push(`export KEYGATE_CODEX_BIN=${shellQuote(spec.env['KEYGATE_CODEX_BIN'])}`);
  }

  lines.push(`exec ${toShellCommand(spec.command, spec.args)}`);
  lines.push('');

  return lines.join('\n');
}

export function buildLinuxUnitContent(launcherPath: string): string {
  return [
    '[Unit]',
    'Description=Keygate Gateway Service',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${launcherPath}`,
    'Restart=on-failure',
    'RestartSec=2',
    'Environment=KEYGATE_OPEN_CHAT_ON_START=false',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function buildLaunchdPlistContent(launcherPath: string): string {
  const escapedLauncher = escapeXml(launcherPath);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${MACOS_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/sh</string>',
    `    <string>${escapedLauncher}</string>`,
    '  </array>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>KEYGATE_OPEN_CHAT_ON_START</key>',
    '    <string>false</string>',
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function buildPowerShellLauncherContent(spec: ServeLaunchSpec): string {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$env:KEYGATE_OPEN_CHAT_ON_START = 'false'",
  ];

  if (spec.env['PATH']) {
    lines.push(`$env:Path = ${quotePowerShell(spec.env['PATH'])}`);
  }

  if (spec.env['KEYGATE_CODEX_BIN']) {
    lines.push(`$env:KEYGATE_CODEX_BIN = ${quotePowerShell(spec.env['KEYGATE_CODEX_BIN'])}`);
  }

  lines.push(`& ${toPowerShellInvocation(spec.command, spec.args)}`);
  lines.push('');
  return lines.join('\n');
}

function printGatewayStatus(deps: GatewayDeps, status: GatewayStatus): void {
  deps.log(`Gateway status: ${status.state}`);
  if (status.detail.trim().length > 0) {
    deps.log(`Detail: ${status.detail}`);
  }
}

function resolveLaunchdDomain(deps: GatewayDeps): string {
  if (deps.uid === null) {
    throw unsupportedManagerError('darwin', 'Unable to determine current user id (uid) for launchd domain.');
  }
  return `gui/${deps.uid}`;
}

function resolvePowerShellCommand(deps: GatewayDeps): string {
  if (hasCommand(deps, 'powershell')) {
    return 'powershell';
  }

  if (hasCommand(deps, 'pwsh')) {
    return 'pwsh';
  }

  return 'powershell';
}

function assertLinuxManagerAvailable(deps: GatewayDeps): void {
  if (!hasCommand(deps, 'systemctl')) {
    throw unsupportedManagerError('linux', 'systemctl is not available.');
  }

  const result = deps.runCommand('systemctl', ['--user', 'show-environment']);
  if (result.error || result.status !== 0) {
    const message = commandOutput(result);
    throw unsupportedManagerError(
      'linux',
      `systemd --user is not available in this session${message ? ` (${message})` : ''}.`
    );
  }
}

function assertMacOSManagerAvailable(deps: GatewayDeps): void {
  if (!hasCommand(deps, 'launchctl')) {
    throw unsupportedManagerError('darwin', 'launchctl is not available.');
  }

  if (deps.uid === null) {
    throw unsupportedManagerError('darwin', 'Unable to determine current user id (uid).');
  }
}

function assertWindowsManagerAvailable(deps: GatewayDeps, powershell: string): void {
  if (!hasCommand(deps, 'schtasks')) {
    throw unsupportedManagerError('win32', 'schtasks is not available.');
  }

  if (!hasCommand(deps, powershell)) {
    throw unsupportedManagerError('win32', `${powershell} is not available.`);
  }
}

function hasCommand(deps: GatewayDeps, command: string): boolean {
  const args = command === 'schtasks' ? ['/?'] : ['--help'];
  const result = deps.runCommand(command, args);
  return !result.error;
}

function runOrThrow(
  deps: GatewayDeps,
  command: string,
  args: string[],
  failurePrefix: string,
  options?: { input?: string }
): void {
  const result = deps.runCommand(command, args, options);
  if (result.status === 0) {
    return;
  }

  const message = commandOutput(result);
  throw new Error(`${failurePrefix}: ${message}`);
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

function isWindowsTaskMissingOrStoppedMessage(message: string): boolean {
  return /cannot find the file|cannot find the task|not currently running|task does not exist|cannot find path/i.test(
    message
  );
}

function unsupportedManagerError(platform: NodeJS.Platform | string, reason: string): Error {
  const lines = [
    `Gateway background lifecycle is unavailable on ${platform}: ${reason}`,
    'Run Keygate in foreground instead:',
    '  keygate serve',
  ];
  return new Error(lines.join('\n'));
}

function toShellCommand(command: string, args: string[]): string {
  return [shellQuote(command), ...args.map((arg) => shellQuote(arg))].join(' ');
}

function toPowerShellInvocation(command: string, args: string[]): string {
  return [quotePowerShell(command), ...args.map((arg) => quotePowerShell(arg))].join(' ');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${escapePowerShellString(value)}'`;
}

function escapePowerShellString(value: string): string {
  return value.replace(/'/g, "''");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function extractKeyValue(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^${key}=(.+)$`, 'mi'));
  if (!match || !match[1]) {
    return null;
  }
  return match[1].trim();
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

function resolveCodexBinary(deps: GatewayDeps): string | null {
  const explicit = deps.envCodexBin?.trim();
  if (explicit && path.isAbsolute(explicit)) {
    return explicit;
  }

  const inheritedPath = deps.envPath?.trim();
  if (!inheritedPath) {
    return null;
  }

  return findExecutableInPath('codex', inheritedPath, deps.platform, deps.envPathExt);
}

function findExecutableInPath(
  command: string,
  pathValue: string,
  platform: NodeJS.Platform,
  pathExtValue: string | undefined
): string | null {
  const segments = pathValue
    .split(path.delimiter)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (platform !== 'win32') {
    for (const segment of segments) {
      const candidate = path.join(segment, command);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  const extensions = (pathExtValue ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);

  for (const segment of segments) {
    const direct = path.join(segment, command);
    if (existsSync(direct)) {
      return direct;
    }

    for (const ext of extensions) {
      const candidate = path.join(segment, `${command}${ext}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}
