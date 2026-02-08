import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { getConfigDir } from '../../config/env.js';
import type { ParsedArgs } from '../argv.js';
import { runGatewayCommand, type GatewayAction } from './gateway.js';

export type ChannelName = 'web' | 'discord';
export type ChannelAction = 'start' | 'stop' | 'restart' | 'status' | 'config';
export type DiscordChannelState = {
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  startedAt: string;
};
export type ChannelRuntimeState = 'running' | 'stopped' | 'unknown';

interface ChannelStatus {
  state: ChannelRuntimeState;
  detail: string;
}

interface LaunchSpec {
  command: string;
  args: string[];
  cwd: string;
}

interface ChannelCommandDeps {
  configDir: string;
  cwd: string;
  argv1: string | undefined;
  execPath: string;
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
  readFile: (targetPath: string) => Promise<string>;
  writeFile: (targetPath: string, content: string) => Promise<void>;
  mkdir: (targetPath: string) => Promise<void>;
  unlink: (targetPath: string) => Promise<void>;
  pathExists: (targetPath: string) => boolean;
  spawnDetached: (spec: LaunchSpec) => number;
  kill: (pid: number, signal?: NodeJS.Signals | number) => void;
  runGatewayAction: (action: GatewayAction) => Promise<void>;
  hasCommand: (command: string) => boolean;
  now: () => Date;
}

const CHANNELS_USAGE = 'Usage: keygate channels <web|discord> <start|stop|restart|status|config>';
const DISABLED_ENV_VALUES = new Set(['0', 'false', 'no', 'off']);
const DEFAULT_DISCORD_PREFIX = '!keygate ';

export async function runChannelsCommand(
  args: ParsedArgs,
  depsOverride?: Partial<ChannelCommandDeps>
): Promise<void> {
  const channel = parseChannelName(args.positional[1]);
  const action = parseChannelAction(args.positional[2]);

  if (!channel || !action) {
    throw new Error(CHANNELS_USAGE);
  }

  const deps = createChannelDeps(depsOverride);

  if (channel === 'web') {
    await runWebChannelAction(action, deps);
    return;
  }

  await runDiscordChannelAction(action, deps);
}

export function parseChannelName(value: string | undefined): ChannelName | null {
  if (value === 'web' || value === 'discord') {
    return value;
  }

  return null;
}

export function parseChannelAction(value: string | undefined): ChannelAction | null {
  if (value === 'start' || value === 'stop' || value === 'restart' || value === 'status' || value === 'config') {
    return value;
  }

  return null;
}

function createChannelDeps(overrides?: Partial<ChannelCommandDeps>): ChannelCommandDeps {
  const defaults: ChannelCommandDeps = {
    configDir: getConfigDir(),
    cwd: process.cwd(),
    argv1: process.argv[1],
    execPath: process.execPath,
    env: process.env,
    log: (message: string) => {
      console.log(message);
    },
    readFile: async (targetPath: string) => fs.readFile(targetPath, 'utf8'),
    writeFile: async (targetPath: string, content: string) => {
      await fs.writeFile(targetPath, content, 'utf8');
    },
    mkdir: async (targetPath: string) => {
      await fs.mkdir(targetPath, { recursive: true });
    },
    unlink: async (targetPath: string) => {
      await fs.unlink(targetPath);
    },
    pathExists: (targetPath: string) => existsSync(targetPath),
    spawnDetached: (spec: LaunchSpec) => {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: process.env,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      if (!child.pid) {
        throw new Error('Unable to determine discord channel process id.');
      }
      return child.pid;
    },
    kill: (pid: number, signal?: NodeJS.Signals | number) => {
      process.kill(pid, signal ?? 0);
    },
    runGatewayAction: async (action: GatewayAction) => {
      await runGatewayCommand({
        positional: ['gateway', action],
        flags: {},
      });
    },
    hasCommand: (command: string) => {
      const args = command === 'pnpm' ? ['--version'] : ['--help'];
      const result = spawnSync(command, args, { encoding: 'utf8' });
      return !result.error;
    },
    now: () => new Date(),
  };

  if (!overrides) {
    return defaults;
  }

  const deps: ChannelCommandDeps = {
    ...defaults,
    ...overrides,
  };

  if (!overrides.spawnDetached) {
    deps.spawnDetached = (spec: LaunchSpec) => {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: deps.env,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      if (!child.pid) {
        throw new Error('Unable to determine discord channel process id.');
      }
      return child.pid;
    };
  }

  return deps;
}

async function runWebChannelAction(action: ChannelAction, deps: ChannelCommandDeps): Promise<void> {
  if (action === 'config') {
    printWebChannelConfig(deps);
    return;
  }

  await deps.runGatewayAction(toGatewayAction(action));
}

function printWebChannelConfig(deps: ChannelCommandDeps): void {
  const port = resolveWebPort(deps.env['PORT']);
  const autoOpen = shouldAutoOpenChat(deps.env['KEYGATE_OPEN_CHAT_ON_START']);
  const explicitUrl = deps.env['KEYGATE_CHAT_URL']?.trim();
  const chatUrl = explicitUrl && explicitUrl.length > 0 ? explicitUrl : `http://localhost:${port}`;

  deps.log('Channel: web');
  deps.log(`Port: ${port}`);
  deps.log(`Chat URL: ${chatUrl}`);
  deps.log(`Auto-open on start: ${autoOpen ? 'enabled' : 'disabled'}`);
}

async function runDiscordChannelAction(action: ChannelAction, deps: ChannelCommandDeps): Promise<void> {
  if (action === 'config') {
    await printDiscordChannelConfig(deps);
    return;
  }

  if (action === 'status') {
    const status = await getDiscordStatus(deps);
    printDiscordStatus(deps, status);
    return;
  }

  if (action === 'restart') {
    await stopDiscordChannel(deps);
    await startDiscordChannel(deps);
    const status = await getDiscordStatus(deps);
    deps.log('Discord channel restart requested.');
    printDiscordStatus(deps, status);
    return;
  }

  if (action === 'start') {
    const before = await getDiscordStatus(deps);
    if (before.state === 'running') {
      deps.log('Discord channel is already running.');
      printDiscordStatus(deps, before);
      return;
    }

    await startDiscordChannel(deps);
    const after = await getDiscordStatus(deps);
    deps.log('Discord channel start requested.');
    printDiscordStatus(deps, after);
    return;
  }

  const before = await getDiscordStatus(deps);
  if (before.state === 'stopped') {
    deps.log('Discord channel is already stopped.');
    printDiscordStatus(deps, before);
    return;
  }

  await stopDiscordChannel(deps);
  const after = await getDiscordStatus(deps);
  deps.log('Discord channel stop requested.');
  printDiscordStatus(deps, after);
}

async function printDiscordChannelConfig(deps: ChannelCommandDeps): Promise<void> {
  const token = (deps.env['DISCORD_TOKEN'] ?? '').trim();
  const prefix = resolveDiscordPrefix(deps.env['DISCORD_PREFIX']);
  const state = await readDiscordState(deps);
  const launchCommand = resolveDiscordLaunchCommand(deps);

  deps.log('Channel: discord');
  deps.log(`Token configured: ${token.length > 0 ? 'yes' : 'no'}`);
  deps.log(`Prefix: ${JSON.stringify(prefix)}`);
  if (state) {
    deps.log(`Managed process state file: ${discordStateFilePath(deps)}`);
    deps.log(`Last known pid: ${state.pid}`);
  }
  deps.log(`Launch command: ${launchCommand}`);
}

async function startDiscordChannel(deps: ChannelCommandDeps): Promise<void> {
  const token = (deps.env['DISCORD_TOKEN'] ?? '').trim();
  if (!token) {
    throw new Error('Discord token is missing. Configure DISCORD_TOKEN before starting discord channel.');
  }

  const launchSpec = resolveDiscordLaunchSpec(deps);
  const pid = deps.spawnDetached(launchSpec);

  await deps.mkdir(path.dirname(discordStateFilePath(deps)));
  const state: DiscordChannelState = {
    pid,
    command: launchSpec.command,
    args: launchSpec.args,
    cwd: launchSpec.cwd,
    startedAt: deps.now().toISOString(),
  };
  await writeDiscordState(deps, state);
  await waitForStart(deps, pid);
}

async function stopDiscordChannel(deps: ChannelCommandDeps): Promise<void> {
  const state = await readDiscordState(deps);
  if (!state) {
    return;
  }

  if (!isProcessAlive(deps, state.pid)) {
    await clearDiscordState(deps);
    return;
  }

  try {
    deps.kill(state.pid, 'SIGTERM');
  } catch {
    await clearDiscordState(deps);
    return;
  }

  await waitForExit(deps, state.pid, 5_000);
  if (isProcessAlive(deps, state.pid)) {
    try {
      deps.kill(state.pid, 'SIGKILL');
    } catch {
      // no-op
    }
    await waitForExit(deps, state.pid, 2_000);
  }

  if (isProcessAlive(deps, state.pid)) {
    throw new Error(`Unable to stop discord channel process pid=${state.pid}.`);
  }

  await clearDiscordState(deps);
}

async function getDiscordStatus(deps: ChannelCommandDeps): Promise<ChannelStatus> {
  const state = await readDiscordState(deps);
  if (!state) {
    return {
      state: 'stopped',
      detail: 'no managed discord process state found',
    };
  }

  if (isProcessAlive(deps, state.pid)) {
    const args = state.args.map((value) => JSON.stringify(value)).join(' ');
    const command = `${state.command}${args.length > 0 ? ` ${args}` : ''}`;
    return {
      state: 'running',
      detail: `pid=${state.pid}, cwd=${state.cwd}, startedAt=${state.startedAt}, command=${command}`,
    };
  }

  await clearDiscordState(deps);
  return {
    state: 'stopped',
    detail: 'stale discord process state removed',
  };
}

function printDiscordStatus(deps: ChannelCommandDeps, status: ChannelStatus): void {
  deps.log(`Discord channel status: ${status.state}`);
  if (status.detail.trim().length > 0) {
    deps.log(`Detail: ${status.detail}`);
  }
}

function resolveDiscordLaunchSpec(deps: ChannelCommandDeps): LaunchSpec {
  const configured = deps.env['KEYGATE_DISCORD_START_COMMAND']?.trim();
  if (configured) {
    return {
      command: shellForPlatform(),
      args: shellArgsForPlatform(configured),
      cwd: deps.cwd,
    };
  }

  const repoRoot = resolveRepoRoot(deps);
  if (!repoRoot) {
    throw new Error(
      'Unable to resolve discord channel runtime. Set KEYGATE_DISCORD_START_COMMAND or run from the keygate repository.'
    );
  }

  const distEntry = path.join(repoRoot, 'packages', 'discord', 'dist', 'index.js');
  if (deps.pathExists(distEntry)) {
    return {
      command: deps.execPath,
      args: [distEntry],
      cwd: repoRoot,
    };
  }

  const sourceEntry = path.join(repoRoot, 'packages', 'discord', 'src', 'index.ts');
  if (deps.pathExists(sourceEntry) && deps.hasCommand('pnpm')) {
    return {
      command: 'pnpm',
      args: ['--filter', '@puukis/discord', 'exec', 'tsx', 'src/index.ts'],
      cwd: repoRoot,
    };
  }

  throw new Error(
    'Unable to resolve discord channel runtime. Build @puukis/discord (`pnpm --filter @puukis/discord build`) or set KEYGATE_DISCORD_START_COMMAND.'
  );
}

function resolveDiscordLaunchCommand(deps: ChannelCommandDeps): string {
  try {
    const spec = resolveDiscordLaunchSpec(deps);
    return `${spec.command} ${spec.args.join(' ')}`.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unresolved (${message})`;
  }
}

function toGatewayAction(action: Exclude<ChannelAction, 'config'>): GatewayAction {
  switch (action) {
    case 'start':
      return 'open';
    case 'stop':
      return 'close';
    case 'restart':
      return 'restart';
    case 'status':
      return 'status';
  }
}

function shouldAutoOpenChat(rawValue: string | undefined): boolean {
  if (!rawValue) {
    return true;
  }

  return !DISABLED_ENV_VALUES.has(rawValue.trim().toLowerCase());
}

function resolveWebPort(rawValue: string | undefined): number {
  const parsed = Number.parseInt(rawValue ?? '18790', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 18790;
  }
  return parsed;
}

function resolveDiscordPrefix(value: string | undefined): string {
  if (typeof value !== 'string') {
    return DEFAULT_DISCORD_PREFIX;
  }

  if (value.trim().length === 0) {
    return DEFAULT_DISCORD_PREFIX;
  }

  return value;
}

function discordStateFilePath(deps: ChannelCommandDeps): string {
  return path.join(deps.configDir, 'channels', 'discord.json');
}

async function readDiscordState(deps: ChannelCommandDeps): Promise<DiscordChannelState | null> {
  const statePath = discordStateFilePath(deps);
  if (!deps.pathExists(statePath)) {
    return null;
  }

  try {
    const raw = await deps.readFile(statePath);
    const parsed = JSON.parse(raw) as Partial<DiscordChannelState>;
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.command !== 'string' ||
      !Array.isArray(parsed.args) ||
      !parsed.args.every((item) => typeof item === 'string') ||
      typeof parsed.cwd !== 'string' ||
      typeof parsed.startedAt !== 'string'
    ) {
      return null;
    }

    return {
      pid: parsed.pid,
      command: parsed.command,
      args: parsed.args,
      cwd: parsed.cwd,
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

async function writeDiscordState(deps: ChannelCommandDeps, state: DiscordChannelState): Promise<void> {
  const statePath = discordStateFilePath(deps);
  await deps.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function clearDiscordState(deps: ChannelCommandDeps): Promise<void> {
  const statePath = discordStateFilePath(deps);
  try {
    await deps.unlink(statePath);
  } catch {
    // no-op
  }
}

function isProcessAlive(deps: ChannelCommandDeps, pid: number): boolean {
  try {
    deps.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

async function waitForStart(deps: ChannelCommandDeps, pid: number): Promise<void> {
  await wait(250);
  if (isProcessAlive(deps, pid)) {
    return;
  }

  await clearDiscordState(deps);
  throw new Error('Discord channel failed to stay running after start.');
}

async function waitForExit(deps: ChannelCommandDeps, pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(deps, pid)) {
      return;
    }
    await wait(125);
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shellForPlatform(): string {
  if (process.platform === 'win32') {
    return 'cmd';
  }

  return '/bin/sh';
}

function shellArgsForPlatform(command: string): string[] {
  if (process.platform === 'win32') {
    return ['/c', command];
  }

  return ['-lc', command];
}

function findRepoRoot(startDir: string, pathExists: (targetPath: string) => boolean): string | null {
  let current = path.resolve(startDir);

  while (true) {
    const marker = path.join(current, 'pnpm-workspace.yaml');
    if (pathExists(marker)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

function resolveRepoRoot(deps: ChannelCommandDeps): string | null {
  const fromCwd = findRepoRoot(deps.cwd, deps.pathExists);
  if (fromCwd) {
    return fromCwd;
  }

  if (!deps.argv1) {
    return null;
  }

  return findRepoRoot(path.dirname(path.resolve(deps.argv1)), deps.pathExists);
}
