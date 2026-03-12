import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { getConfigDir } from '../../config/env.js';
import type { ParsedArgs } from '../argv.js';

export type NgrokAction = 'start' | 'stop' | 'status' | 'restart' | 'url';
export type NgrokState = 'running' | 'stopped' | 'unknown';

export interface NgrokStatus {
  state: NgrokState;
  detail: string;
  publicUrl?: string;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | undefined;
}

export interface NgrokDeps {
  platform: NodeJS.Platform;
  uid: number | null;
  homeDir: string;
  configDir: string;
  log: (message: string) => void;
  mkdir: (targetPath: string) => Promise<void>;
  writeFile: (targetPath: string, content: string) => Promise<void>;
  runCommand: (command: string, args: string[], options?: { input?: string }) => CommandResult;
  readFile: (targetPath: string) => Promise<string>;
  fetchJson: (url: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
}

interface NgrokManagerAdapter {
  ensureDefinition(): Promise<void>;
  open(): Promise<void>;
  close(): Promise<void>;
  status(): Promise<NgrokStatus>;
}

interface NgrokLaunchdConfig {
  label: string;
  plistPath: string;
  logPath: string;
  port: number;
}

const MACOS_LABEL = 'com.keygate.ngrok';
const DEFAULT_PORT = 18790;
const INSPECT_API_URL = 'http://127.0.0.1:4040/api/tunnels';
const NGROK_USAGE = 'Usage: keygate ngrok <start|stop|status|restart|url>';

export async function runNgrokCommand(args: ParsedArgs, depsOverride?: Partial<NgrokDeps>): Promise<void> {
  const action = parseNgrokAction(args.positional[1]);
  if (!action) {
    throw new Error(NGROK_USAGE);
  }

  const deps = createNgrokDeps(depsOverride);
  const adapter = createNgrokAdapter(deps);

  if (action === 'url') {
    const status = await attachPublicUrl(deps, await adapter.status(), 1);
    if (status.state !== 'running') {
      throw new Error('Ngrok tunnel is not running. Start it with `keygate ngrok start` first.');
    }

    if (!status.publicUrl) {
      throw new Error('Ngrok is running, but no public URL is available yet. Try again in a moment.');
    }

    deps.log(status.publicUrl);
    return;
  }

  if (action === 'status') {
    printNgrokStatus(deps, await attachPublicUrl(deps, await adapter.status()));
    return;
  }

  if (action === 'start') {
    const before = await attachPublicUrl(deps, await adapter.status(), 1);
    if (before.state === 'running') {
      deps.log('Ngrok tunnel is already running.');
      printNgrokStatus(deps, before);
      return;
    }

    await adapter.ensureDefinition();
    await adapter.open();
    deps.log('Ngrok start requested.');
    printNgrokStatus(deps, await settleNgrokStatus(deps, adapter));
    return;
  }

  if (action === 'restart') {
    await adapter.ensureDefinition();
    await adapter.close();
    await deps.sleep(800);
    await adapter.open();
    deps.log('Ngrok restart requested.');
    printNgrokStatus(deps, await settleNgrokStatus(deps, adapter));
    return;
  }

  const before = await adapter.status();
  if (before.state === 'stopped') {
    deps.log('Ngrok tunnel is already stopped.');
    printNgrokStatus(deps, before);
    return;
  }

  await adapter.close();
  deps.log('Ngrok stop requested.');
  printNgrokStatus(deps, await adapter.status());
}

export function parseNgrokAction(value: string | undefined): NgrokAction | null {
  if (value === 'start' || value === 'stop' || value === 'status' || value === 'restart' || value === 'url') {
    return value;
  }

  return null;
}

export function buildNgrokLaunchdPlistContent(ngrokBinary: string, port: number, logPath: string): string {
  const escapedBinary = escapeXml(ngrokBinary);
  const escapedLogPath = escapeXml(logPath);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${MACOS_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${escapedBinary}</string>`,
    '    <string>http</string>',
    `    <string>${port}</string>`,
    '    <string>--log</string>',
    `    <string>${escapedLogPath}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapedLogPath}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapedLogPath}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function createNgrokDeps(overrides?: Partial<NgrokDeps>): NgrokDeps {
  const defaults: NgrokDeps = {
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    homeDir: os.homedir(),
    configDir: getConfigDir(),
    log: (message: string) => {
      console.log(message);
    },
    mkdir: async (targetPath: string) => {
      await fs.mkdir(targetPath, { recursive: true });
    },
    writeFile: async (targetPath: string, content: string) => {
      await fs.writeFile(targetPath, content, 'utf8');
    },
    runCommand: (command: string, args: string[], options?: { input?: string }) => runSync(command, args, options),
    readFile: async (targetPath: string) => fs.readFile(targetPath, 'utf8'),
    fetchJson: async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      return response.json();
    },
    sleep: delay,
  };

  if (!overrides) {
    return defaults;
  }

  return {
    ...defaults,
    ...overrides,
  };
}

function createNgrokAdapter(deps: NgrokDeps): NgrokManagerAdapter {
  if (deps.platform !== 'darwin') {
    throw unsupportedManagerError(
      deps.platform,
      'launchctl-backed ngrok management is currently implemented for macOS only.'
    );
  }

  const config = buildLaunchdConfig(deps);
  const domain = resolveLaunchdDomain(deps);

  return {
    async ensureDefinition() {
      assertMacOSManagerAvailable(deps);
      await deps.mkdir(deps.configDir);
      await deps.mkdir(path.dirname(config.plistPath));
      const ngrokBinary = resolveNgrokBinary(deps);
      await deps.writeFile(config.plistPath, buildNgrokLaunchdPlistContent(ngrokBinary, config.port, config.logPath));
    },

    async open() {
      const bootstrap = deps.runCommand('launchctl', ['bootstrap', domain, config.plistPath]);
      if (bootstrap.status !== 0) {
        const message = commandOutput(bootstrap);
        if (!isLaunchdAlreadyLoadedMessage(message)) {
          deps.runCommand('launchctl', ['bootout', `${domain}/${config.label}`]);
          await deps.sleep(1000);
          const retry = deps.runCommand('launchctl', ['bootstrap', domain, config.plistPath]);
          if (retry.status !== 0) {
            const retryMessage = commandOutput(retry);
            if (!isLaunchdAlreadyLoadedMessage(retryMessage)) {
              throw new Error(`Failed to bootstrap ngrok launchd service: ${retryMessage}`);
            }
          }
        }
      }

      runOrThrow(
        deps,
        'launchctl',
        ['kickstart', '-k', `${domain}/${config.label}`],
        'Failed to kickstart ngrok launchd service'
      );
    },

    async close() {
      const result = deps.runCommand('launchctl', ['bootout', `${domain}/${config.label}`]);
      if (result.status === 0) {
        return;
      }

      const message = commandOutput(result);
      if (isLaunchdNotLoadedMessage(message)) {
        return;
      }

      throw new Error(`Failed to stop ngrok launchd service: ${message}`);
    },

    async status() {
      const result = deps.runCommand('launchctl', ['print', `${domain}/${config.label}`]);
      const output = commandOutput(result);

      if (result.status !== 0) {
        if (isLaunchdNotLoadedMessage(output)) {
          return { state: 'stopped', detail: 'launchd service is not loaded' };
        }
        return { state: 'unknown', detail: output };
      }

      const stateMatch = result.stdout.match(/state = ([a-zA-Z]+)/);
      const pidMatch = result.stdout.match(/pid = ([0-9]+)/);
      const activeCountMatch = result.stdout.match(/active count = ([0-9]+)/);
      const lastExitCodeMatch = result.stdout.match(/last exit code = (-?[0-9]+)/);

      const activeCount = activeCountMatch ? Number.parseInt(activeCountMatch[1]!, 10) : Number.NaN;
      const lastExitCode = lastExitCodeMatch ? Number.parseInt(lastExitCodeMatch[1]!, 10) : 0;

      if ((pidMatch || stateMatch?.[1]?.toLowerCase() === 'running') && (Number.isNaN(activeCount) || activeCount > 0)) {
        const pidSegment = pidMatch ? ` pid=${pidMatch[1]}` : '';
        return {
          state: 'running',
          detail: `launchd state=${stateMatch?.[1] ?? 'running'}${pidSegment}`,
        };
      }

      if (!Number.isNaN(activeCount) && activeCount === 0) {
        if (lastExitCode !== 0) {
          const logTail = await readTailSafe(deps, config.logPath, 60);
          const traceSegment = logTail ? `\nTrace:\n${logTail}` : '';
          return {
            state: 'unknown',
            detail: `launchd crashed (last exit code=${lastExitCode}).${traceSegment}`,
          };
        }

        return {
          state: 'stopped',
          detail: `launchd state=${stateMatch?.[1] ?? 'inactive'} active_count=0`,
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

function buildLaunchdConfig(deps: NgrokDeps): NgrokLaunchdConfig {
  return {
    label: MACOS_LABEL,
    plistPath: path.join(deps.homeDir, 'Library', 'LaunchAgents', `${MACOS_LABEL}.plist`),
    logPath: path.join(deps.configDir, 'ngrok.log'),
    port: DEFAULT_PORT,
  };
}

async function settleNgrokStatus(deps: NgrokDeps, adapter: NgrokManagerAdapter): Promise<NgrokStatus> {
  const first = await adapter.status();
  if (first.state !== 'running') {
    return first;
  }

  await deps.sleep(700);
  return attachPublicUrl(deps, await adapter.status());
}

async function attachPublicUrl(deps: NgrokDeps, status: NgrokStatus, attempts = 4): Promise<NgrokStatus> {
  if (status.state !== 'running') {
    return status;
  }

  const publicUrl = await getNgrokPublicUrl(deps, attempts);
  if (!publicUrl) {
    return status;
  }

  return {
    ...status,
    publicUrl,
  };
}

async function getNgrokPublicUrl(deps: NgrokDeps, attempts: number): Promise<string | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const publicUrl = await fetchNgrokPublicUrl(deps);
    if (publicUrl) {
      return publicUrl;
    }

    if (attempt < attempts - 1) {
      await deps.sleep(400);
    }
  }

  return undefined;
}

async function fetchNgrokPublicUrl(deps: NgrokDeps): Promise<string | undefined> {
  try {
    const payload = await deps.fetchJson(INSPECT_API_URL);
    const tunnels = extractTunnels(payload);
    const preferred = tunnels.find((entry) => entry.proto === 'https') ?? tunnels[0];
    const publicUrl = preferred?.publicUrl?.trim();
    return publicUrl ? publicUrl : undefined;
  } catch {
    return undefined;
  }
}

function extractTunnels(payload: unknown): Array<{ publicUrl?: string; proto?: string }> {
  if (!payload || typeof payload !== 'object' || !('tunnels' in payload)) {
    return [];
  }

  const tunnels = (payload as { tunnels?: unknown }).tunnels;
  if (!Array.isArray(tunnels)) {
    return [];
  }

  return tunnels
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => ({
      publicUrl: typeof entry['public_url'] === 'string' ? entry['public_url'] : undefined,
      proto: typeof entry['proto'] === 'string' ? entry['proto'] : undefined,
    }))
    .filter((entry) => Boolean(entry.publicUrl));
}

function printNgrokStatus(deps: NgrokDeps, status: NgrokStatus): void {
  deps.log(`Ngrok status: ${status.state}`);
  if (status.detail.trim().length > 0) {
    deps.log(`Detail: ${status.detail}`);
  }
  if (status.publicUrl) {
    deps.log(`Public URL: ${status.publicUrl}`);
  }
}

function resolveNgrokBinary(deps: NgrokDeps): string {
  const whichResult = deps.runCommand('which', ['ngrok']);
  if (!whichResult.error && whichResult.status === 0) {
    const resolved = whichResult.stdout
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .find((line) => line.length > 0);

    if (resolved) {
      const check = deps.runCommand(resolved, ['version']);
      if (!check.error && check.status === 0) {
        return resolved;
      }
    }
  }

  for (const candidate of ['/opt/homebrew/bin/ngrok', '/usr/local/bin/ngrok', '/usr/bin/ngrok']) {
    const check = deps.runCommand(candidate, ['version']);
    if (!check.error && check.status === 0) {
      return candidate;
    }
  }

  throw new Error('ngrok is not available. Install ngrok and ensure it is on PATH before using `keygate ngrok`.');
}

async function readTailSafe(deps: NgrokDeps, filePath: string, maxLines: number): Promise<string> {
  try {
    const raw = await deps.readFile(filePath);
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    return lines.slice(-Math.max(1, maxLines)).join('\n');
  } catch {
    return '';
  }
}

function resolveLaunchdDomain(deps: NgrokDeps): string {
  if (deps.uid === null) {
    throw unsupportedManagerError('darwin', 'Unable to determine current user id (uid) for launchd domain.');
  }
  return `gui/${deps.uid}`;
}

function assertMacOSManagerAvailable(deps: NgrokDeps): void {
  if (!hasCommand(deps, 'launchctl')) {
    throw unsupportedManagerError('darwin', 'launchctl is not available.');
  }

  if (deps.uid === null) {
    throw unsupportedManagerError('darwin', 'Unable to determine current user id (uid).');
  }
}

function hasCommand(deps: NgrokDeps, command: string): boolean {
  const args = command === 'which' ? ['ngrok'] : ['--help'];
  const result = deps.runCommand(command, args);
  return !result.error;
}

function runOrThrow(
  deps: NgrokDeps,
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

function isLaunchdAlreadyLoadedMessage(message: string): boolean {
  return /service already loaded|already bootstrapped|in progress/i.test(message);
}

function isLaunchdNotLoadedMessage(message: string): boolean {
  return /could not find service|service not found|no such process|does not exist|not loaded/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unsupportedManagerError(platform: NodeJS.Platform | string, reason: string): Error {
  const lines = [
    `Ngrok background lifecycle is unavailable on ${platform}: ${reason}`,
    'Run ngrok in the foreground instead:',
    `  ngrok http ${DEFAULT_PORT}`,
  ];
  return new Error(lines.join('\n'));
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
