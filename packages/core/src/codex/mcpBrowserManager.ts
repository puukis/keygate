import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { BrowserDomainPolicy, KeygateConfig } from '../types.js';

export const PLAYWRIGHT_MCP_SERVER_NAME = 'playwright';
export const CODEX_REASONING_EFFORT_COMPAT = 'model_reasoning_effort=high';
const PLAYWRIGHT_MCP_PACKAGE_NAME = '@playwright/mcp';

interface CodexMcpTransport {
  type: string;
  command?: string;
  args?: string[];
  env?: Record<string, string> | null;
  cwd?: string | null;
}

interface CodexMcpServer {
  name: string;
  enabled?: boolean;
  transport?: CodexMcpTransport;
}

interface DesiredPlaywrightServer {
  name: string;
  command: string;
  args: string[];
}

export interface BrowserArtifactsCleanupResult {
  deletedFiles: number;
}

export interface MCPBrowserStatus {
  installed: boolean;
  healthy: boolean;
  serverName: string;
  configuredVersion: string | null;
  desiredVersion: string;
  domainPolicy: BrowserDomainPolicy;
  domainAllowlist: string[];
  domainBlocklist: string[];
  traceRetentionDays: number;
  artifactsPath: string;
  command: string | null;
  args: string[];
  warning?: string;
}

interface CommandExecutionResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface MCPBrowserManagerOptions {
  codexCommand?: string;
  runCommand?: (command: string, args: string[]) => CommandExecutionResult;
}

export class MCPBrowserManager {
  private readonly codexCommand: string;
  private readonly runCommand: (command: string, args: string[]) => CommandExecutionResult;

  constructor(
    private readonly config: KeygateConfig,
    options: MCPBrowserManagerOptions = {}
  ) {
    this.codexCommand = options.codexCommand ?? resolveCodexCommandFromEnv();
    this.runCommand = options.runCommand ?? runCommandSync;
  }

  async status(): Promise<MCPBrowserStatus> {
    await this.cleanupArtifacts();

    try {
      const server = this.getServer(PLAYWRIGHT_MCP_SERVER_NAME);
      return this.buildStatus(server);
    } catch (error) {
      return this.buildStatus(null, error instanceof Error ? error.message : String(error));
    }
  }

  async setup(): Promise<MCPBrowserStatus> {
    await fs.mkdir(this.config.browser.artifactsPath, { recursive: true });
    await this.cleanupArtifacts();

    const desired = this.getDesiredServer();
    const existing = this.getServer(PLAYWRIGHT_MCP_SERVER_NAME);

    if (!existing || !isDesiredPlaywrightServer(existing, desired)) {
      if (existing) {
        this.execCodex(['mcp', 'remove', PLAYWRIGHT_MCP_SERVER_NAME], true);
      }

      this.execCodex(['mcp', 'add', PLAYWRIGHT_MCP_SERVER_NAME, desired.command, ...desired.args]);
    }

    const server = this.getServer(PLAYWRIGHT_MCP_SERVER_NAME);
    return this.buildStatus(server);
  }

  async update(): Promise<MCPBrowserStatus> {
    return this.setup();
  }

  async remove(): Promise<MCPBrowserStatus> {
    this.execCodex(['mcp', 'remove', PLAYWRIGHT_MCP_SERVER_NAME], true);
    await this.cleanupArtifacts();
    return this.status();
  }

  async cleanupArtifacts(): Promise<BrowserArtifactsCleanupResult> {
    const root = path.resolve(this.config.browser.artifactsPath);
    const retentionDays = Math.max(1, this.config.browser.traceRetentionDays);
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    const deletedFiles = await deleteOldFiles(root, cutoff);
    return { deletedFiles };
  }

  private getDesiredServer(): DesiredPlaywrightServer {
    return {
      name: PLAYWRIGHT_MCP_SERVER_NAME,
      command: 'pnpm',
      args: ['dlx', ...buildPlaywrightMcpArgs(this.config)],
    };
  }

  private buildStatus(server: CodexMcpServer | null, warning?: string): MCPBrowserStatus {
    const desired = this.getDesiredServer();
    const configuredVersion = server ? parsePlaywrightVersion(server) : null;
    const command = server?.transport?.command ?? null;
    const args = Array.isArray(server?.transport?.args) ? server!.transport!.args! : [];

    return {
      installed: Boolean(server),
      healthy: Boolean(server && isDesiredPlaywrightServer(server, desired)),
      serverName: PLAYWRIGHT_MCP_SERVER_NAME,
      configuredVersion,
      desiredVersion: this.config.browser.mcpPlaywrightVersion,
      domainPolicy: this.config.browser.domainPolicy,
      domainAllowlist: [...this.config.browser.domainAllowlist],
      domainBlocklist: [...this.config.browser.domainBlocklist],
      traceRetentionDays: this.config.browser.traceRetentionDays,
      artifactsPath: path.resolve(this.config.browser.artifactsPath),
      command,
      args,
      warning,
    };
  }

  private getServer(name: string): CodexMcpServer | null {
    const listResult = this.execCodex(['mcp', 'list', '--json']);
    const servers = safeParseJsonArray<CodexMcpServer>(listResult.stdout);
    const listed = servers.find((server) => server.name === name) ?? null;

    const getResult = this.execCodex(['mcp', 'get', name, '--json'], true);
    if (getResult.status !== 0) {
      if (isServerNotFoundError(getResult)) {
        return listed;
      }

      throw new Error(formatCommandFailure('codex mcp get', getResult));
    }

    const parsed = safeParseJsonObject<CodexMcpServer>(getResult.stdout);
    if (parsed) {
      return parsed;
    }

    return listed;
  }

  private execCodex(args: string[], allowFailure = false): CommandExecutionResult {
    const finalArgs = ['-c', CODEX_REASONING_EFFORT_COMPAT, ...args];
    const result = this.runCommand(this.codexCommand, finalArgs);

    if (!allowFailure && result.status !== 0) {
      throw new Error(formatCommandFailure(`codex ${args.join(' ')}`, result));
    }

    return result;
  }
}

export function buildPlaywrightMcpArgs(config: KeygateConfig): string[] {
  const args = [
    `${PLAYWRIGHT_MCP_PACKAGE_NAME}@${config.browser.mcpPlaywrightVersion}`,
    '--headless',
    '--isolated',
    '--output-mode',
    'file',
    '--output-dir',
    path.resolve(config.browser.artifactsPath),
    ...buildDomainPolicyFlags(
      config.browser.domainPolicy,
      config.browser.domainAllowlist,
      config.browser.domainBlocklist
    ),
  ];

  return args;
}

export function buildDomainPolicyFlags(
  policy: BrowserDomainPolicy,
  allowlist: string[],
  blocklist: string[]
): string[] {
  const normalizedAllowlist = normalizeOriginList(allowlist);
  const normalizedBlocklist = normalizeOriginList(blocklist);

  if (policy === 'allowlist' && normalizedAllowlist.length > 0) {
    return ['--allowed-origins', normalizedAllowlist.join(',')];
  }

  if (policy === 'blocklist' && normalizedBlocklist.length > 0) {
    return ['--blocked-origins', normalizedBlocklist.join(',')];
  }

  return [];
}

export function normalizeOriginList(origins: string[]): string[] {
  return Array.from(new Set(origins.map((origin) => origin.trim()).filter((origin) => origin.length > 0)));
}

export function parsePlaywrightVersion(server: Pick<CodexMcpServer, 'transport'>): string | null {
  const command = server.transport?.command;
  const args = Array.isArray(server.transport?.args) ? server.transport!.args! : [];

  const candidates: string[] = [];
  if (typeof command === 'string') {
    candidates.push(command);
  }
  candidates.push(...args);

  for (const candidate of candidates) {
    const match = candidate.match(/@playwright\/mcp@([^\s]+)/);
    if (match) {
      return match[1]!;
    }
  }

  return null;
}

export function isDesiredPlaywrightServer(
  server: Pick<CodexMcpServer, 'name' | 'transport'>,
  desired: DesiredPlaywrightServer
): boolean {
  if (server.name !== desired.name) {
    return false;
  }

  const transport = server.transport;
  if (!transport || transport.type !== 'stdio') {
    return false;
  }

  if (transport.command !== desired.command) {
    return false;
  }

  const existingArgs = Array.isArray(transport.args) ? transport.args : [];
  if (existingArgs.length !== desired.args.length) {
    return false;
  }

  return existingArgs.every((arg, index) => arg === desired.args[index]);
}

function resolveCodexCommandFromEnv(): string {
  const explicit = process.env['KEYGATE_CODEX_BIN']?.trim();
  if (explicit) {
    return explicit;
  }

  return 'codex';
}

function runCommandSync(command: string, args: string[]): CommandExecutionResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
  }) as SpawnSyncReturns<string>;

  const status = typeof result.status === 'number' ? result.status : 1;
  return {
    status,
    stdout: (result.stdout ?? '').toString(),
    stderr: (result.stderr ?? '').toString(),
  };
}

function safeParseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function safeParseJsonObject<T>(raw: string): T | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as T;
    }
    return null;
  } catch {
    return null;
  }
}

function isServerNotFoundError(result: CommandExecutionResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return output.includes('no mcp server named');
}

function formatCommandFailure(command: string, result: CommandExecutionResult): string {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  if (stderr.length > 0) {
    return `${command} failed: ${stderr}`;
  }
  if (stdout.length > 0) {
    return `${command} failed: ${stdout}`;
  }
  return `${command} failed with exit code ${result.status}`;
}

async function deleteOldFiles(rootDir: string, cutoffMs: number): Promise<number> {
  try {
    const stats = await fs.stat(rootDir);
    if (!stats.isDirectory()) {
      return 0;
    }
  } catch {
    return 0;
  }

  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  let deletedFiles = 0;

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      deletedFiles += await deleteOldFiles(fullPath, cutoffMs);

      try {
        const remaining = await fs.readdir(fullPath);
        if (remaining.length === 0) {
          await fs.rmdir(fullPath);
        }
      } catch {
        // Ignore cleanup failures.
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    try {
      const stat = await fs.stat(fullPath);
      if (stat.mtimeMs < cutoffMs) {
        await fs.unlink(fullPath);
        deletedFiles += 1;
      }
    } catch {
      // Ignore individual file errors.
    }
  }

  return deletedFiles;
}
