import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import dotenv from 'dotenv';
import type { BrowserDomainPolicy, CodexReasoningEffort, KeygateConfig } from '../types.js';

const DEFAULT_ALLOWED_BINARIES = ['git', 'ls', 'npm', 'cat', 'node', 'python3'];
const DEFAULT_DISCORD_PREFIX = '!keygate ';
const DEFAULT_BROWSER_TRACE_RETENTION_DAYS = 7;
const DEFAULT_MCP_PLAYWRIGHT_VERSION = '0.0.64';
const DEFAULT_BROWSER_ARTIFACTS_DIRNAME = '.keygate-browser-runs';

export function getConfigHomeDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']?.trim();
    if (appData) {
      return appData;
    }
    return path.join(os.homedir(), 'AppData', 'Roaming');
  }

  const xdgConfigHome = process.env['XDG_CONFIG_HOME']?.trim();
  if (xdgConfigHome) {
    return xdgConfigHome;
  }

  return path.join(os.homedir(), '.config');
}

export function getConfigDir(): string {
  return path.join(getConfigHomeDir(), 'keygate');
}

export function getDeviceId(): string {
  return sanitizeDeviceName(os.hostname());
}

export function getDefaultWorkspacePath(): string {
  return path.join(getConfigDir(), 'workspaces', getDeviceId());
}

export function getLegacyWorkspacePath(): string {
  return path.join(os.homedir(), 'keygate-workspace');
}

export function getKeygateFilePath(): string {
  return path.join(getConfigDir(), '.keygate');
}

export function loadEnvironment(): void {
  dotenv.config({ path: getKeygateFilePath() });
  dotenv.config({ path: path.resolve(process.cwd(), '.keygate') });
}

export function loadConfigFromEnv(): KeygateConfig {
  const provider = normalizeProvider(process.env['LLM_PROVIDER']);
  const workspacePath = resolveWorkspacePath(process.env['WORKSPACE_PATH']);
  const spicyModeEnabled = process.env['SPICY_MODE_ENABLED'] === 'true';
  const spicyMaxObedienceEnabled =
    spicyModeEnabled && process.env['SPICY_MAX_OBEDIENCE_ENABLED'] === 'true';
  const discordPrefix = normalizeDiscordPrefix(process.env['DISCORD_PREFIX']);

  const domainPolicy = normalizeBrowserDomainPolicy(process.env['BROWSER_DOMAIN_POLICY']);
  const domainAllowlist = parseDomainList(process.env['BROWSER_DOMAIN_ALLOWLIST']);
  const domainBlocklist = parseDomainList(process.env['BROWSER_DOMAIN_BLOCKLIST']);
  const traceRetentionDays = parsePositiveInteger(
    process.env['BROWSER_TRACE_RETENTION_DAYS'],
    DEFAULT_BROWSER_TRACE_RETENTION_DAYS
  );
  const mcpPlaywrightVersion = normalizeMcpPlaywrightVersion(process.env['MCP_PLAYWRIGHT_VERSION']);
  const artifactsPath = resolveBrowserArtifactsPath(workspacePath);

  return {
    llm: {
      provider,
      model: process.env['LLM_MODEL'] ?? getDefaultModelForProvider(provider),
      reasoningEffort:
        normalizeCodexReasoningEffort(process.env['LLM_REASONING_EFFORT']) ??
        (provider === 'openai-codex' ? 'medium' : undefined),
      apiKey: process.env['LLM_API_KEY'] ?? '',
      ollama: {
        host: process.env['LLM_OLLAMA_HOST'] ?? 'http://127.0.0.1:11434',
      },
    },
    security: {
      mode: 'safe',
      spicyModeEnabled,
      spicyMaxObedienceEnabled,
      workspacePath,
      allowedBinaries: DEFAULT_ALLOWED_BINARIES,
    },
    server: {
      port: parseInt(process.env['PORT'] ?? '18790', 10),
    },
    browser: {
      domainPolicy,
      domainAllowlist,
      domainBlocklist,
      traceRetentionDays,
      mcpPlaywrightVersion,
      artifactsPath,
    },
    discord: {
      token: process.env['DISCORD_TOKEN'] ?? '',
      prefix: discordPrefix,
    },
  };
}

function resolveWorkspacePath(value: string | undefined): string {
  const configured = value?.trim();
  if (!configured) {
    return getDefaultWorkspacePath();
  }

  const expanded = expandHomePath(configured);
  const resolved = path.resolve(expanded);
  const legacy = path.resolve(getLegacyWorkspacePath());

  // Auto-migrate historical default workspace to per-device config workspace.
  if (resolved === legacy) {
    return getDefaultWorkspacePath();
  }

  return expanded;
}

function resolveBrowserArtifactsPath(workspacePath: string): string {
  const resolvedWorkspace = path.resolve(expandHomePath(workspacePath));
  return path.join(resolvedWorkspace, DEFAULT_BROWSER_ARTIFACTS_DIRNAME);
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

export async function updateKeygateFile(updates: Record<string, string>): Promise<void> {
  const keygatePath = getKeygateFilePath();

  await fs.mkdir(path.dirname(keygatePath), { recursive: true });

  let content = '';
  try {
    content = await fs.readFile(keygatePath, 'utf8');
  } catch {
    content = '';
  }

  const lines = content.length > 0 ? content.split(/\r?\n/g) : [];
  const seen = new Set<string>();

  const updatedLines = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      return line;
    }

    const key = match[1]!;
    if (!Object.prototype.hasOwnProperty.call(updates, key)) {
      return line;
    }

    seen.add(key);
    return `${key}=${serializeEnvValue(updates[key]!)}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (seen.has(key)) {
      continue;
    }
    updatedLines.push(`${key}=${serializeEnvValue(value)}`);
  }

  const normalized = updatedLines
    .map((line) => line.trimEnd())
    .filter((line, index, array) => !(index === array.length - 1 && line === ''))
    .join('\n');

  await fs.writeFile(keygatePath, `${normalized}\n`, 'utf8');
}

function normalizeProvider(value: string | undefined): KeygateConfig['llm']['provider'] {
  switch (value) {
    case 'openai':
    case 'gemini':
    case 'ollama':
    case 'openai-codex':
      return value;
    default:
      return 'openai';
  }
}

function normalizeCodexReasoningEffort(value: string | undefined): CodexReasoningEffort | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  switch (normalized) {
    case 'low':
    case 'medium':
    case 'high':
      return normalized;
    case 'xhigh':
    case 'extra-high':
    case 'extra_high':
    case 'extra high':
      return 'xhigh';
    default:
      return undefined;
  }
}

function normalizeBrowserDomainPolicy(value: string | undefined): BrowserDomainPolicy {
  switch (value?.trim().toLowerCase()) {
    case 'allowlist':
      return 'allowlist';
    case 'blocklist':
      return 'blocklist';
    case 'none':
    default:
      return 'none';
  }
}

function parseDomainList(value: string | undefined): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

function normalizeMcpPlaywrightVersion(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    return DEFAULT_MCP_PLAYWRIGHT_VERSION;
  }

  return normalized;
}

export function getDefaultModelForProvider(provider: KeygateConfig['llm']['provider']): string {
  switch (provider) {
    case 'openai':
      return 'gpt-4o';
    case 'gemini':
      return 'gemini-1.5-pro';
    case 'ollama':
      return 'llama3';
    case 'openai-codex':
      return 'openai-codex/gpt-5.3';
    default:
      return 'gpt-4o';
  }
}

function serializeEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:\-]*$/.test(value)) {
    return value;
  }

  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');

  return `"${escaped}"`;
}

function sanitizeDeviceName(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/g, '')
    .replace(/-+$/g, '');

  if (sanitized.length > 0) {
    return sanitized;
  }

  return 'device';
}

function normalizeDiscordPrefix(value: string | undefined): string {
  const parsed = parseDiscordPrefixes(value);
  if (parsed.length === 0) {
    return DEFAULT_DISCORD_PREFIX;
  }

  if (parsed.length === 1 && typeof value === 'string' && !value.includes(',')) {
    return parsed[0]!;
  }

  return parsed.join(', ');
}

function parseDiscordPrefixes(value: string | undefined): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  if (!value.includes(',')) {
    return value.trim().length > 0 ? [value] : [];
  }

  return value
    .split(',')
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix.length > 0);
}
