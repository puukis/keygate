import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { getConfigDir, loadConfigFromEnv } from '../../config/env.js';
import {
  buildWhatsAppConfigView,
  logoutWhatsAppLinkedDevice,
  startWhatsAppLogin,
  waitForActiveWhatsAppLoginResult,
} from '../../whatsapp/index.js';
import { getFlagString, hasFlag, type ParsedArgs } from '../argv.js';
import { runGatewayCommand, type GatewayAction } from './gateway.js';

export type ChannelName = 'web' | 'discord' | 'slack' | 'whatsapp' | 'telegram';
export type ChannelAction = 'start' | 'stop' | 'restart' | 'status' | 'config' | 'login' | 'logout';
export type DiscordChannelState = {
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  startedAt: string;
};
export type SlackChannelState = DiscordChannelState;
export type WhatsAppChannelState = DiscordChannelState;
export type TelegramChannelState = DiscordChannelState;
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

const CHANNELS_USAGE = 'Usage: keygate channels <web|discord|slack|whatsapp|telegram> <start|stop|restart|status|config|login|logout>';
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

  if (channel === 'slack') {
    await runSlackChannelAction(action, deps);
    return;
  }

  if (channel === 'whatsapp') {
    await runWhatsAppChannelAction(action, args, deps);
    return;
  }

  if (channel === 'telegram') {
    await runTelegramChannelAction(action, deps);
    return;
  }

  await runDiscordChannelAction(action, deps);
}

export function parseChannelName(value: string | undefined): ChannelName | null {
  if (value === 'web' || value === 'discord' || value === 'slack' || value === 'whatsapp' || value === 'telegram') {
    return value;
  }

  return null;
}

export function parseChannelAction(value: string | undefined): ChannelAction | null {
  if (
    value === 'start' ||
    value === 'stop' ||
    value === 'restart' ||
    value === 'status' ||
    value === 'config' ||
    value === 'login' ||
    value === 'logout'
  ) {
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
  if (action === 'login' || action === 'logout') {
    throw new Error('Web channel does not support login or logout actions.');
  }

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
  if (action === 'login' || action === 'logout') {
    throw new Error('Discord channel does not support login or logout actions.');
  }

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

function toGatewayAction(action: Extract<ChannelAction, 'start' | 'stop' | 'restart' | 'status'>): GatewayAction {
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

// ── Slack channel ──

async function runSlackChannelAction(action: ChannelAction, deps: ChannelCommandDeps): Promise<void> {
  if (action === 'login' || action === 'logout') {
    throw new Error('Slack channel does not support login or logout actions.');
  }

  if (action === 'config') {
    await printSlackChannelConfig(deps);
    return;
  }

  if (action === 'status') {
    const status = await getSlackStatus(deps);
    printSlackStatus(deps, status);
    return;
  }

  if (action === 'restart') {
    await stopSlackChannel(deps);
    await startSlackChannel(deps);
    const status = await getSlackStatus(deps);
    deps.log('Slack channel restart requested.');
    printSlackStatus(deps, status);
    return;
  }

  if (action === 'start') {
    const before = await getSlackStatus(deps);
    if (before.state === 'running') {
      deps.log('Slack channel is already running.');
      printSlackStatus(deps, before);
      return;
    }

    await startSlackChannel(deps);
    const after = await getSlackStatus(deps);
    deps.log('Slack channel start requested.');
    printSlackStatus(deps, after);
    return;
  }

  const before = await getSlackStatus(deps);
  if (before.state === 'stopped') {
    deps.log('Slack channel is already stopped.');
    printSlackStatus(deps, before);
    return;
  }

  await stopSlackChannel(deps);
  const after = await getSlackStatus(deps);
  deps.log('Slack channel stop requested.');
  printSlackStatus(deps, after);
}

async function printSlackChannelConfig(deps: ChannelCommandDeps): Promise<void> {
  const botToken = (deps.env['SLACK_BOT_TOKEN'] ?? '').trim();
  const appToken = (deps.env['SLACK_APP_TOKEN'] ?? '').trim();
  const state = await readSlackState(deps);
  const launchCommand = resolveSlackLaunchCommand(deps);

  deps.log('Channel: slack');
  deps.log(`Bot token configured: ${botToken.length > 0 ? 'yes' : 'no'}`);
  deps.log(`App token configured: ${appToken.length > 0 ? 'yes' : 'no'}`);
  if (state) {
    deps.log(`Managed process state file: ${slackStateFilePath(deps)}`);
    deps.log(`Last known pid: ${state.pid}`);
  }
  deps.log(`Launch command: ${launchCommand}`);
}

async function startSlackChannel(deps: ChannelCommandDeps): Promise<void> {
  const botToken = (deps.env['SLACK_BOT_TOKEN'] ?? '').trim();
  if (!botToken) {
    throw new Error('Slack bot token is missing. Configure SLACK_BOT_TOKEN before starting slack channel.');
  }

  const appToken = (deps.env['SLACK_APP_TOKEN'] ?? '').trim();
  if (!appToken) {
    throw new Error('Slack app token is missing. Configure SLACK_APP_TOKEN before starting slack channel.');
  }

  const launchSpec = resolveSlackLaunchSpec(deps);
  const pid = deps.spawnDetached(launchSpec);

  await deps.mkdir(path.dirname(slackStateFilePath(deps)));
  const state: SlackChannelState = {
    pid,
    command: launchSpec.command,
    args: launchSpec.args,
    cwd: launchSpec.cwd,
    startedAt: deps.now().toISOString(),
  };
  await writeSlackState(deps, state);
  await waitForSlackStart(deps, pid);
}

async function stopSlackChannel(deps: ChannelCommandDeps): Promise<void> {
  const state = await readSlackState(deps);
  if (!state) {
    return;
  }

  if (!isProcessAlive(deps, state.pid)) {
    await clearSlackState(deps);
    return;
  }

  try {
    deps.kill(state.pid, 'SIGTERM');
  } catch {
    await clearSlackState(deps);
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
    throw new Error(`Unable to stop slack channel process pid=${state.pid}.`);
  }

  await clearSlackState(deps);
}

async function getSlackStatus(deps: ChannelCommandDeps): Promise<ChannelStatus> {
  const state = await readSlackState(deps);
  if (!state) {
    return {
      state: 'stopped',
      detail: 'no managed slack process state found',
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

  await clearSlackState(deps);
  return {
    state: 'stopped',
    detail: 'stale slack process state removed',
  };
}

function printSlackStatus(deps: ChannelCommandDeps, status: ChannelStatus): void {
  deps.log(`Slack channel status: ${status.state}`);
  if (status.detail.trim().length > 0) {
    deps.log(`Detail: ${status.detail}`);
  }
}

function resolveSlackLaunchSpec(deps: ChannelCommandDeps): LaunchSpec {
  const configured = deps.env['KEYGATE_SLACK_START_COMMAND']?.trim();
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
      'Unable to resolve slack channel runtime. Set KEYGATE_SLACK_START_COMMAND or run from the keygate repository.'
    );
  }

  const distEntry = path.join(repoRoot, 'packages', 'slack', 'dist', 'index.js');
  if (deps.pathExists(distEntry)) {
    return {
      command: deps.execPath,
      args: [distEntry],
      cwd: repoRoot,
    };
  }

  const sourceEntry = path.join(repoRoot, 'packages', 'slack', 'src', 'index.ts');
  if (deps.pathExists(sourceEntry) && deps.hasCommand('pnpm')) {
    return {
      command: 'pnpm',
      args: ['--filter', '@puukis/slack', 'exec', 'tsx', 'src/index.ts'],
      cwd: repoRoot,
    };
  }

  throw new Error(
    'Unable to resolve slack channel runtime. Build @puukis/slack (`pnpm --filter @puukis/slack build`) or set KEYGATE_SLACK_START_COMMAND.'
  );
}

function resolveSlackLaunchCommand(deps: ChannelCommandDeps): string {
  try {
    const spec = resolveSlackLaunchSpec(deps);
    return `${spec.command} ${spec.args.join(' ')}`.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unresolved (${message})`;
  }
}

function slackStateFilePath(deps: ChannelCommandDeps): string {
  return path.join(deps.configDir, 'channels', 'slack.json');
}

async function readSlackState(deps: ChannelCommandDeps): Promise<SlackChannelState | null> {
  const statePath = slackStateFilePath(deps);
  if (!deps.pathExists(statePath)) {
    return null;
  }

  try {
    const raw = await deps.readFile(statePath);
    const parsed = JSON.parse(raw) as Partial<SlackChannelState>;
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

async function writeSlackState(deps: ChannelCommandDeps, state: SlackChannelState): Promise<void> {
  const statePath = slackStateFilePath(deps);
  await deps.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function clearSlackState(deps: ChannelCommandDeps): Promise<void> {
  const statePath = slackStateFilePath(deps);
  try {
    await deps.unlink(statePath);
  } catch {
    // no-op
  }
}

async function waitForSlackStart(deps: ChannelCommandDeps, pid: number): Promise<void> {
  await wait(250);
  if (isProcessAlive(deps, pid)) {
    return;
  }

  await clearSlackState(deps);
  throw new Error('Slack channel failed to stay running after start.');
}

// ── WhatsApp channel ──

async function runWhatsAppChannelAction(
  action: ChannelAction,
  args: ParsedArgs,
  deps: ChannelCommandDeps
): Promise<void> {
  if (action === 'login') {
    const timeoutSecondsRaw = getFlagString(args.flags, 'timeout', '120');
    const timeoutSeconds = Number.parseInt(timeoutSecondsRaw, 10);
    const timeoutMs = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds * 1000 : 120_000;
    await startWhatsAppLogin({
      force: hasFlag(args.flags, 'force'),
      timeoutMs,
      printQrToTerminal: true,
    });

    const result = await waitForActiveWhatsAppLoginResult();
    if (!result?.ok) {
      throw new Error(result?.error ?? 'WhatsApp login did not complete.');
    }

    deps.log(`WhatsApp linked successfully${result.linkedPhone ? ` (${result.linkedPhone})` : ''}.`);
    return;
  }

  if (action === 'logout') {
    await stopWhatsAppChannel(deps);
    await logoutWhatsAppLinkedDevice();
    deps.log('WhatsApp linked session cleared.');
    return;
  }

  if (action === 'config') {
    await printWhatsAppChannelConfig(deps);
    return;
  }

  if (action === 'status') {
    const status = await getWhatsAppStatus(deps);
    await printWhatsAppStatus(deps, status);
    return;
  }

  if (action === 'restart') {
    await stopWhatsAppChannel(deps);
    await startWhatsAppChannel(deps);
    const status = await getWhatsAppStatus(deps);
    deps.log('WhatsApp channel restart requested.');
    await printWhatsAppStatus(deps, status);
    return;
  }

  if (action === 'start') {
    const before = await getWhatsAppStatus(deps);
    if (before.state === 'running') {
      deps.log('WhatsApp channel is already running.');
      await printWhatsAppStatus(deps, before);
      return;
    }

    await startWhatsAppChannel(deps);
    const after = await getWhatsAppStatus(deps);
    deps.log('WhatsApp channel start requested.');
    await printWhatsAppStatus(deps, after);
    return;
  }

  const before = await getWhatsAppStatus(deps);
  if (before.state === 'stopped') {
    deps.log('WhatsApp channel is already stopped.');
    await printWhatsAppStatus(deps, before);
    return;
  }

  await stopWhatsAppChannel(deps);
  const after = await getWhatsAppStatus(deps);
  deps.log('WhatsApp channel stop requested.');
  await printWhatsAppStatus(deps, after);
}

async function printWhatsAppChannelConfig(deps: ChannelCommandDeps): Promise<void> {
  const config = loadConfigFromEnv();
  const view = await buildWhatsAppConfigView(config);
  const state = await readWhatsAppState(deps);
  const launchCommand = resolveWhatsAppLaunchCommand(deps);

  deps.log('Channel: whatsapp');
  deps.log(`Linked: ${view.linked ? 'yes' : 'no'}`);
  deps.log(`Linked phone: ${view.linkedPhone ?? 'unknown'}`);
  deps.log(`Auth directory: ${view.authDir}`);
  deps.log(`DM policy: ${view.dmPolicy}`);
  deps.log(`Allow-from: ${view.allowFrom.length > 0 ? view.allowFrom.join(', ') : '(empty)'}`);
  deps.log(`Group mode: ${view.groupMode}`);
  deps.log(`Explicit groups: ${Object.keys(view.groups).length > 0 ? Object.keys(view.groups).join(', ') : '(none)'}`);
  deps.log(`Read receipts: ${view.sendReadReceipts ? 'enabled' : 'disabled'}`);
  if (state) {
    deps.log(`Managed process state file: ${whatsappStateFilePath(deps)}`);
    deps.log(`Last known pid: ${state.pid}`);
  }
  deps.log(`Launch command: ${launchCommand}`);
}

async function startWhatsAppChannel(deps: ChannelCommandDeps): Promise<void> {
  if (!deps.pathExists(whatsappAuthCredsPath(deps))) {
    throw new Error('WhatsApp is not linked. Run `keygate channels whatsapp login` first.');
  }

  const launchSpec = resolveWhatsAppLaunchSpec(deps);
  const pid = deps.spawnDetached(launchSpec);

  await deps.mkdir(path.dirname(whatsappStateFilePath(deps)));
  const state: WhatsAppChannelState = {
    pid,
    command: launchSpec.command,
    args: launchSpec.args,
    cwd: launchSpec.cwd,
    startedAt: deps.now().toISOString(),
  };
  await writeWhatsAppState(deps, state);
  await waitForWhatsAppStart(deps, pid);
}

async function stopWhatsAppChannel(deps: ChannelCommandDeps): Promise<void> {
  const state = await readWhatsAppState(deps);
  if (!state) {
    return;
  }

  if (!isProcessAlive(deps, state.pid)) {
    await clearWhatsAppState(deps);
    return;
  }

  try {
    deps.kill(state.pid, 'SIGTERM');
  } catch {
    await clearWhatsAppState(deps);
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
    throw new Error(`Unable to stop whatsapp channel process pid=${state.pid}.`);
  }

  await clearWhatsAppState(deps);
}

async function getWhatsAppStatus(deps: ChannelCommandDeps): Promise<ChannelStatus> {
  const state = await readWhatsAppState(deps);
  if (!state) {
    return {
      state: 'stopped',
      detail: 'no managed whatsapp process state found',
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

  await clearWhatsAppState(deps);
  return {
    state: 'stopped',
    detail: 'stale whatsapp process state removed',
  };
}

async function printWhatsAppStatus(deps: ChannelCommandDeps, status: ChannelStatus): Promise<void> {
  const view = await buildWhatsAppConfigView(loadConfigFromEnv());
  deps.log(`WhatsApp channel status: ${status.state}`);
  if (status.detail.trim().length > 0) {
    deps.log(`Detail: ${status.detail}`);
  }
  deps.log(`Linked: ${view.linked ? 'yes' : 'no'}`);
  deps.log(`Linked phone: ${view.linkedPhone ?? 'unknown'}`);
  deps.log(`DM policy: ${view.dmPolicy}`);
  deps.log(`Allowlist entries: ${view.allowFrom.length}`);
  deps.log(`Group mode: ${view.groupMode}`);
  deps.log(`Configured group rules: ${Object.keys(view.groups).length}`);
}

function resolveWhatsAppLaunchSpec(deps: ChannelCommandDeps): LaunchSpec {
  const configured = deps.env['KEYGATE_WHATSAPP_START_COMMAND']?.trim();
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
      'Unable to resolve whatsapp channel runtime. Set KEYGATE_WHATSAPP_START_COMMAND or run from the keygate repository.'
    );
  }

  const distEntry = path.join(repoRoot, 'packages', 'whatsapp', 'dist', 'index.js');
  if (deps.pathExists(distEntry)) {
    return {
      command: deps.execPath,
      args: [distEntry],
      cwd: repoRoot,
    };
  }

  const sourceEntry = path.join(repoRoot, 'packages', 'whatsapp', 'src', 'index.ts');
  if (deps.pathExists(sourceEntry) && deps.hasCommand('pnpm')) {
    return {
      command: 'pnpm',
      args: ['--filter', '@puukis/whatsapp', 'exec', 'tsx', 'src/index.ts'],
      cwd: repoRoot,
    };
  }

  throw new Error(
    'Unable to resolve whatsapp channel runtime. Build @puukis/whatsapp (`pnpm --filter @puukis/whatsapp build`) or set KEYGATE_WHATSAPP_START_COMMAND.'
  );
}

function resolveWhatsAppLaunchCommand(deps: ChannelCommandDeps): string {
  try {
    const spec = resolveWhatsAppLaunchSpec(deps);
    return `${spec.command} ${spec.args.join(' ')}`.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unresolved (${message})`;
  }
}

function whatsappStateFilePath(deps: ChannelCommandDeps): string {
  return path.join(deps.configDir, 'channels', 'whatsapp.json');
}

function whatsappAuthCredsPath(deps: ChannelCommandDeps): string {
  return path.join(deps.configDir, 'channels', 'whatsapp', 'auth', 'creds.json');
}

async function readWhatsAppState(deps: ChannelCommandDeps): Promise<WhatsAppChannelState | null> {
  const statePath = whatsappStateFilePath(deps);
  if (!deps.pathExists(statePath)) {
    return null;
  }

  try {
    const raw = await deps.readFile(statePath);
    const parsed = JSON.parse(raw) as Partial<WhatsAppChannelState>;
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

async function writeWhatsAppState(deps: ChannelCommandDeps, state: WhatsAppChannelState): Promise<void> {
  await deps.writeFile(whatsappStateFilePath(deps), `${JSON.stringify(state, null, 2)}\n`);
}

async function clearWhatsAppState(deps: ChannelCommandDeps): Promise<void> {
  try {
    await deps.unlink(whatsappStateFilePath(deps));
  } catch {
    // no-op
  }
}

async function waitForWhatsAppStart(deps: ChannelCommandDeps, pid: number): Promise<void> {
  await wait(250);
  if (isProcessAlive(deps, pid)) {
    return;
  }

  await clearWhatsAppState(deps);
  throw new Error('WhatsApp channel failed to stay running after start.');
}

// ── Telegram channel ──

async function runTelegramChannelAction(action: ChannelAction, deps: ChannelCommandDeps): Promise<void> {
  if (action === 'login' || action === 'logout') {
    throw new Error('Telegram channel does not support login or logout actions.');
  }

  if (action === 'config') {
    await printTelegramChannelConfig(deps);
    return;
  }

  if (action === 'status') {
    const status = await getTelegramStatus(deps);
    printTelegramStatus(deps, status);
    return;
  }

  if (action === 'restart') {
    await stopTelegramChannel(deps);
    await startTelegramChannel(deps);
    const status = await getTelegramStatus(deps);
    deps.log('Telegram channel restart requested.');
    printTelegramStatus(deps, status);
    return;
  }

  if (action === 'start') {
    const before = await getTelegramStatus(deps);
    if (before.state === 'running') {
      deps.log('Telegram channel is already running.');
      printTelegramStatus(deps, before);
      return;
    }

    await startTelegramChannel(deps);
    const after = await getTelegramStatus(deps);
    deps.log('Telegram channel start requested.');
    printTelegramStatus(deps, after);
    return;
  }

  const before = await getTelegramStatus(deps);
  if (before.state === 'stopped') {
    deps.log('Telegram channel is already stopped.');
    printTelegramStatus(deps, before);
    return;
  }

  await stopTelegramChannel(deps);
  const after = await getTelegramStatus(deps);
  deps.log('Telegram channel stop requested.');
  printTelegramStatus(deps, after);
}

async function printTelegramChannelConfig(deps: ChannelCommandDeps): Promise<void> {
  const token = (deps.env['TELEGRAM_BOT_TOKEN'] ?? '').trim();
  const dmPolicy = (deps.env['TELEGRAM_DM_POLICY'] ?? 'pairing').trim();
  const groupMode = (deps.env['TELEGRAM_GROUP_MODE'] ?? 'closed').trim();
  const state = await readTelegramState(deps);
  const launchCommand = resolveTelegramLaunchCommand(deps);

  deps.log('Channel: telegram');
  deps.log(`Token configured: ${token.length > 0 ? 'yes' : 'no'}`);
  deps.log(`DM policy: ${dmPolicy}`);
  deps.log(`Group mode: ${groupMode}`);
  if (state) {
    deps.log(`Managed process state file: ${telegramStateFilePath(deps)}`);
    deps.log(`Last known pid: ${state.pid}`);
  }
  deps.log(`Launch command: ${launchCommand}`);
}

async function startTelegramChannel(deps: ChannelCommandDeps): Promise<void> {
  const token = (deps.env['TELEGRAM_BOT_TOKEN'] ?? '').trim();
  if (!token) {
    throw new Error('Telegram bot token is missing. Configure TELEGRAM_BOT_TOKEN before starting telegram channel.');
  }

  const launchSpec = resolveTelegramLaunchSpec(deps);
  const pid = deps.spawnDetached(launchSpec);

  await deps.mkdir(path.dirname(telegramStateFilePath(deps)));
  const state: TelegramChannelState = {
    pid,
    command: launchSpec.command,
    args: launchSpec.args,
    cwd: launchSpec.cwd,
    startedAt: deps.now().toISOString(),
  };
  await writeTelegramState(deps, state);
  await waitForTelegramStart(deps, pid);
}

async function stopTelegramChannel(deps: ChannelCommandDeps): Promise<void> {
  const state = await readTelegramState(deps);
  if (!state) {
    return;
  }

  if (!isProcessAlive(deps, state.pid)) {
    await clearTelegramState(deps);
    return;
  }

  try {
    deps.kill(state.pid, 'SIGTERM');
  } catch {
    await clearTelegramState(deps);
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
    throw new Error(`Unable to stop telegram channel process pid=${state.pid}.`);
  }

  await clearTelegramState(deps);
}

async function getTelegramStatus(deps: ChannelCommandDeps): Promise<ChannelStatus> {
  const state = await readTelegramState(deps);
  if (!state) {
    return {
      state: 'stopped',
      detail: 'no managed telegram process state found',
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

  await clearTelegramState(deps);
  return {
    state: 'stopped',
    detail: 'stale telegram process state removed',
  };
}

function printTelegramStatus(deps: ChannelCommandDeps, status: ChannelStatus): void {
  deps.log(`Telegram channel status: ${status.state}`);
  if (status.detail.trim().length > 0) {
    deps.log(`Detail: ${status.detail}`);
  }
}

function resolveTelegramLaunchSpec(deps: ChannelCommandDeps): LaunchSpec {
  const configured = deps.env['KEYGATE_TELEGRAM_START_COMMAND']?.trim();
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
      'Unable to resolve telegram channel runtime. Set KEYGATE_TELEGRAM_START_COMMAND or run from the keygate repository.'
    );
  }

  const distEntry = path.join(repoRoot, 'packages', 'telegram', 'dist', 'index.js');
  if (deps.pathExists(distEntry)) {
    return {
      command: deps.execPath,
      args: [distEntry],
      cwd: repoRoot,
    };
  }

  const sourceEntry = path.join(repoRoot, 'packages', 'telegram', 'src', 'index.ts');
  if (deps.pathExists(sourceEntry) && deps.hasCommand('pnpm')) {
    return {
      command: 'pnpm',
      args: ['--filter', '@puukis/telegram', 'exec', 'tsx', 'src/index.ts'],
      cwd: repoRoot,
    };
  }

  throw new Error(
    'Unable to resolve telegram channel runtime. Build @puukis/telegram (`pnpm --filter @puukis/telegram build`) or set KEYGATE_TELEGRAM_START_COMMAND.'
  );
}

function resolveTelegramLaunchCommand(deps: ChannelCommandDeps): string {
  try {
    const spec = resolveTelegramLaunchSpec(deps);
    return `${spec.command} ${spec.args.join(' ')}`.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unresolved (${message})`;
  }
}

function telegramStateFilePath(deps: ChannelCommandDeps): string {
  return path.join(deps.configDir, 'channels', 'telegram.json');
}

async function readTelegramState(deps: ChannelCommandDeps): Promise<TelegramChannelState | null> {
  const statePath = telegramStateFilePath(deps);
  if (!deps.pathExists(statePath)) {
    return null;
  }

  try {
    const raw = await deps.readFile(statePath);
    const parsed = JSON.parse(raw) as Partial<TelegramChannelState>;
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

async function writeTelegramState(deps: ChannelCommandDeps, state: TelegramChannelState): Promise<void> {
  const statePath = telegramStateFilePath(deps);
  await deps.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function clearTelegramState(deps: ChannelCommandDeps): Promise<void> {
  const statePath = telegramStateFilePath(deps);
  try {
    await deps.unlink(statePath);
  } catch {
    // no-op
  }
}

async function waitForTelegramStart(deps: ChannelCommandDeps, pid: number): Promise<void> {
  await wait(250);
  if (isProcessAlive(deps, pid)) {
    return;
  }

  await clearTelegramState(deps);
  throw new Error('Telegram channel failed to stay running after start.');
}
