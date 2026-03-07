import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import dotenv from 'dotenv';
import type {
  BrowserDomainPolicy,
  CodexReasoningEffort,
  DmPolicy,
  GmailConfig,
  KeygateConfig,
  LLMPricingOverride,
  NodeManager,
  PluginEntryConfig,
  SandboxScope,
  WhatsAppConfig,
  WhatsAppGroupMode,
} from '../types.js';

const DEFAULT_ALLOWED_BINARIES = ['git', 'ls', 'npm', 'cat', 'node', 'python3'];
const DEFAULT_DISCORD_PREFIX = '!keygate ';
const DEFAULT_BROWSER_TRACE_RETENTION_DAYS = 7;
const DEFAULT_MCP_PLAYWRIGHT_VERSION = '0.0.64';
const DEFAULT_DM_POLICY: DmPolicy = 'pairing';
const DEFAULT_WHATSAPP_GROUP_MODE: WhatsAppGroupMode = 'closed';
const DEFAULT_BROWSER_ARTIFACTS_DIRNAME = '.keygate-browser-runs';
const DEFAULT_SKILLS_WATCH = true;
const DEFAULT_SKILLS_WATCH_DEBOUNCE_MS = 250;
const DEFAULT_SKILLS_NODE_MANAGER: NodeManager = 'npm';
const DEFAULT_PLUGINS_WATCH = true;
const DEFAULT_PLUGINS_WATCH_DEBOUNCE_MS = 250;
const DEFAULT_PLUGINS_NODE_MANAGER: NodeManager = 'npm';
const DEFAULT_SANDBOX_SCOPE: SandboxScope = 'session';
const DEFAULT_SANDBOX_IMAGE = 'ghcr.io/openai/openhands-runtime:latest';
const PREFERRED_CONFIG_DIRNAME = '.keygate';
const LEGACY_CONFIG_DIRNAME = 'keygate';
const PREFERRED_ENV_FILENAME = '.env';
const LEGACY_ENV_FILENAME = '.keygate';

let cachedConfigDir: string | null = null;
let cachedConfigDirKey: string | null = null;
let loggedMigrationWarningKey: string | null = null;

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

export function getPreferredConfigDir(): string {
  return path.join(os.homedir(), PREFERRED_CONFIG_DIRNAME);
}

export function getLegacyConfigDir(): string {
  return path.join(getConfigHomeDir(), LEGACY_CONFIG_DIRNAME);
}

export function getConfigDir(): string {
  return resolveActiveConfigDir();
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

function getLegacyConfigWorkspacePath(): string {
  return path.join(getLegacyConfigDir(), 'workspaces', getDeviceId());
}

export function getPreferredKeygateEnvPath(): string {
  return path.join(getPreferredConfigDir(), PREFERRED_ENV_FILENAME);
}

export function getLegacyKeygateEnvPath(): string {
  return path.join(getLegacyConfigDir(), LEGACY_ENV_FILENAME);
}

export function getKeygateFilePath(): string {
  const configDir = getConfigDir();
  if (isPreferredConfigDir(configDir)) {
    return getPreferredKeygateEnvPath();
  }

  return getLegacyKeygateEnvPath();
}

export function getPersistedConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function loadEnvironment(): void {
  const configDir = getConfigDir();
  dotenv.config({ path: path.join(configDir, PREFERRED_ENV_FILENAME) });
  dotenv.config({ path: path.join(configDir, LEGACY_ENV_FILENAME) });
  dotenv.config({ path: path.resolve(process.cwd(), LEGACY_ENV_FILENAME) });
}

export function loadConfigFromEnv(): KeygateConfig {
  const persistedConfig = loadPersistedConfigObject();
  const persistedSkillsConfig = loadPersistedSkillsConfig(persistedConfig);
  const persistedPluginsConfig = loadPersistedPluginsConfig(persistedConfig);
  const persistedWhatsAppConfig = loadPersistedWhatsAppConfig(persistedConfig);
  const persistedSandboxConfig = loadPersistedSandboxConfig(persistedConfig);
  const persistedGmailConfig = loadPersistedGmailConfig(persistedConfig);
  const pricingOverrides = loadPersistedPricingOverrides(persistedConfig);
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
      pricing: {
        overrides: pricingOverrides,
      },
    },
    security: {
      mode: 'safe',
      spicyModeEnabled,
      spicyMaxObedienceEnabled,
      workspacePath,
      allowedBinaries: DEFAULT_ALLOWED_BINARIES,
      sandbox: {
        backend: 'docker',
        scope: normalizeSandboxScope(process.env['KEYGATE_SANDBOX_SCOPE']) ?? persistedSandboxConfig.scope,
        image: process.env['KEYGATE_SANDBOX_IMAGE']?.trim() || persistedSandboxConfig.image,
        networkAccess: parseBooleanEnv(process.env['KEYGATE_SANDBOX_NETWORK_ACCESS']) ?? persistedSandboxConfig.networkAccess,
        degradeWithoutDocker:
          parseBooleanEnv(process.env['KEYGATE_SANDBOX_DEGRADE_WITHOUT_DOCKER']) ?? persistedSandboxConfig.degradeWithoutDocker,
      },
    },
    server: {
      port: parseInt(process.env['PORT'] ?? '18790', 10),
      apiToken: process.env['KEYGATE_SERVER_API_TOKEN'] ?? loadPersistedServerApiToken(persistedConfig),
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
      dmPolicy: normalizeDmPolicy(process.env['DISCORD_DM_POLICY']),
      allowFrom: parseIdList(process.env['DISCORD_ALLOW_FROM']),
    },
    slack: {
      botToken: process.env['SLACK_BOT_TOKEN'] ?? '',
      appToken: process.env['SLACK_APP_TOKEN'] ?? '',
      signingSecret: process.env['SLACK_SIGNING_SECRET'] ?? '',
      dmPolicy: normalizeDmPolicy(process.env['SLACK_DM_POLICY']),
      allowFrom: parseIdList(process.env['SLACK_ALLOW_FROM']),
    },
    whatsapp: persistedWhatsAppConfig,
    gmail: {
      clientId: process.env['KEYGATE_GMAIL_CLIENT_ID']?.trim() || persistedGmailConfig.clientId,
      authorizationEndpoint:
        process.env['KEYGATE_GMAIL_AUTHORIZATION_ENDPOINT']?.trim() || persistedGmailConfig.authorizationEndpoint,
      tokenEndpoint:
        process.env['KEYGATE_GMAIL_TOKEN_ENDPOINT']?.trim() || persistedGmailConfig.tokenEndpoint,
      redirectUri:
        process.env['KEYGATE_GMAIL_REDIRECT_URI']?.trim() || persistedGmailConfig.redirectUri,
      redirectPort:
        parsePositiveInteger(process.env['KEYGATE_GMAIL_REDIRECT_PORT'], persistedGmailConfig.redirectPort ?? 1488),
      defaults: persistedGmailConfig.defaults,
    },
    skills: persistedSkillsConfig,
    plugins: persistedPluginsConfig,
    memory: {
      provider: (process.env['KEYGATE_MEMORY_PROVIDER'] ?? 'auto') as 'auto' | 'openai' | 'codex' | 'gemini' | 'ollama',
      model: process.env['KEYGATE_MEMORY_MODEL'] || undefined,
      vectorWeight: parseFloat(process.env['KEYGATE_MEMORY_VECTOR_WEIGHT'] ?? '0.7'),
      textWeight: parseFloat(process.env['KEYGATE_MEMORY_TEXT_WEIGHT'] ?? '0.3'),
      maxResults: parseInt(process.env['KEYGATE_MEMORY_MAX_RESULTS'] ?? '6', 10),
      minScore: parseFloat(process.env['KEYGATE_MEMORY_MIN_SCORE'] ?? '0.35'),
      autoIndex: process.env['KEYGATE_MEMORY_AUTO_INDEX'] !== 'false',
      indexSessions: process.env['KEYGATE_MEMORY_INDEX_SESSIONS'] !== 'false',
      temporalDecay: process.env['KEYGATE_MEMORY_TEMPORAL_DECAY'] === 'true',
      temporalHalfLifeDays: parseInt(process.env['KEYGATE_MEMORY_TEMPORAL_HALF_LIFE'] ?? '30', 10),
      mmr: process.env['KEYGATE_MEMORY_MMR'] === 'true',
    },
  };
}

export function loadPersistedConfigObject(): Record<string, unknown> {
  const configPath = getPersistedConfigPath();

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to empty object.
  }

  return {};
}

export async function savePersistedConfigObject(
  mutator: (current: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>
): Promise<Record<string, unknown>> {
  const current = loadPersistedConfigObject();
  const nextCandidate = await mutator({ ...current });
  const next =
    nextCandidate && typeof nextCandidate === 'object' && !Array.isArray(nextCandidate)
      ? nextCandidate
      : {};

  const configPath = getPersistedConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

function resolveWorkspacePath(value: string | undefined): string {
  const configured = value?.trim();
  if (!configured) {
    return getDefaultWorkspacePath();
  }

  const expanded = expandHomePath(configured);
  const resolved = path.resolve(expanded);
  const legacy = path.resolve(getLegacyWorkspacePath());
  const legacyConfigWorkspace = path.resolve(getLegacyConfigWorkspacePath());

  // Auto-migrate historical default workspaces to the per-device config workspace.
  if (resolved === legacy || resolved === legacyConfigWorkspace) {
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
  const configDir = getConfigDir();
  const keygatePath = getKeygateFilePath();
  const legacyNamedPath = getLegacyNamedEnvPath(configDir);

  await fs.mkdir(path.dirname(keygatePath), { recursive: true });
  await promoteLegacyEnvFileForWrite(keygatePath, legacyNamedPath);

  let content = '';
  for (const candidate of uniqueStrings([keygatePath, legacyNamedPath])) {
    try {
      content = await fs.readFile(candidate, 'utf8');
      break;
    } catch {
      // Try the next compatible filename.
    }
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

function resolveActiveConfigDir(): string {
  const cacheKey = getConfigDirCacheKey();
  if (cachedConfigDir && cachedConfigDirKey === cacheKey) {
    return cachedConfigDir;
  }

  const preferredDir = getPreferredConfigDir();
  const legacyDir = getLegacyConfigDir();
  const legacyDirExists = isDirectory(legacyDir);

  if (isDirectory(preferredDir)) {
    if (!legacyDirExists || hasPrimaryConfigState(preferredDir)) {
      cachedConfigDir = preferredDir;
      cachedConfigDirKey = cacheKey;
      return preferredDir;
    }

    try {
      syncMissingConfigEntries(legacyDir, preferredDir);
      promoteLegacyEnvFileSync(preferredDir);
      cachedConfigDir = preferredDir;
      cachedConfigDirKey = cacheKey;
      return preferredDir;
    } catch (error) {
      logMigrationWarningOnce(cacheKey, legacyDir, preferredDir, error);
      cachedConfigDir = legacyDir;
      cachedConfigDirKey = cacheKey;
      return legacyDir;
    }
  }

  if (!legacyDirExists) {
    cachedConfigDir = preferredDir;
    cachedConfigDirKey = cacheKey;
    return preferredDir;
  }

  const preferredPathExisted = existsSync(preferredDir);

  try {
    mkdirSync(path.dirname(preferredDir), { recursive: true });
    cpSync(legacyDir, preferredDir, { recursive: true });
    promoteLegacyEnvFileSync(preferredDir);
    cachedConfigDir = preferredDir;
    cachedConfigDirKey = cacheKey;
    return preferredDir;
  } catch (error) {
    if (!preferredPathExisted) {
      try {
        rmSync(preferredDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures and keep using the legacy path for this process.
      }
    }

    logMigrationWarningOnce(cacheKey, legacyDir, preferredDir, error);
    cachedConfigDir = legacyDir;
    cachedConfigDirKey = cacheKey;
    return legacyDir;
  }
}

function getConfigDirCacheKey(): string {
  return [
    process.platform,
    os.homedir(),
    process.env['HOME'] ?? '',
    process.env['USERPROFILE'] ?? '',
    process.env['APPDATA'] ?? '',
    process.env['XDG_CONFIG_HOME'] ?? '',
  ].join('\0');
}

function isDirectory(targetPath: string): boolean {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function isPreferredConfigDir(targetPath: string): boolean {
  return normalizeForComparison(targetPath) === normalizeForComparison(getPreferredConfigDir());
}

function normalizeForComparison(targetPath: string): string {
  const normalized = path.resolve(targetPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function getLegacyNamedEnvPath(configDir: string): string {
  return path.join(configDir, LEGACY_ENV_FILENAME);
}

function hasPrimaryConfigState(configDir: string): boolean {
  return [
    path.join(configDir, PREFERRED_ENV_FILENAME),
    path.join(configDir, LEGACY_ENV_FILENAME),
    path.join(configDir, 'config.json'),
  ].some((candidate) => existsSync(candidate));
}

function syncMissingConfigEntries(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });

  for (const entryName of readdirSync(sourceDir)) {
    const sourceEntryPath = path.join(sourceDir, entryName);
    const targetEntryPath = path.join(targetDir, entryName);
    const sourceEntryStat = statSync(sourceEntryPath);

    if (sourceEntryStat.isDirectory()) {
      if (isDirectory(targetEntryPath)) {
        syncMissingConfigEntries(sourceEntryPath, targetEntryPath);
        continue;
      }

      if (existsSync(targetEntryPath)) {
        continue;
      }

      cpSync(sourceEntryPath, targetEntryPath, { recursive: true });
      continue;
    }

    if (existsSync(targetEntryPath)) {
      continue;
    }

    cpSync(sourceEntryPath, targetEntryPath);
  }
}

function promoteLegacyEnvFileSync(configDir: string): void {
  const preferredEnvPath = path.join(configDir, PREFERRED_ENV_FILENAME);
  const legacyEnvPath = getLegacyNamedEnvPath(configDir);
  if (existsSync(preferredEnvPath) || !existsSync(legacyEnvPath)) {
    return;
  }

  try {
    renameSync(legacyEnvPath, preferredEnvPath);
  } catch {
    // Keep the legacy filename in place; loadEnvironment still reads it.
  }
}

async function promoteLegacyEnvFileForWrite(preferredPath: string, legacyPath: string): Promise<void> {
  if (preferredPath === legacyPath) {
    return;
  }

  try {
    await fs.access(preferredPath);
    return;
  } catch {
    // The canonical file does not exist yet.
  }

  try {
    await fs.access(legacyPath);
  } catch {
    return;
  }

  try {
    await fs.rename(legacyPath, preferredPath);
  } catch {
    // Keep the legacy filename in place; the fallback read path still covers it.
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function logMigrationWarningOnce(cacheKey: string, legacyDir: string, preferredDir: string, error: unknown): void {
  if (loggedMigrationWarningKey === cacheKey) {
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `Failed to migrate Keygate config from ${legacyDir} to ${preferredDir}; using the legacy path for this run. ${message}`
  );
  loggedMigrationWarningKey = cacheKey;
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

function normalizeDmPolicy(value: string | undefined): DmPolicy {
  switch (value?.trim().toLowerCase()) {
    case 'open':
      return 'open';
    case 'closed':
      return 'closed';
    case 'pairing':
    default:
      return DEFAULT_DM_POLICY;
  }
}

function parseIdList(value: string | undefined): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
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

export function loadPersistedSkillsConfig(
  parsedConfig: Record<string, unknown> | null = loadPersistedConfigObject()
): NonNullable<KeygateConfig['skills']> {
  const defaults = buildDefaultSkillsConfig();
  if (!parsedConfig || typeof parsedConfig !== 'object') {
    return defaults;
  }

  const skills = parsedConfig['skills'];
  if (!skills || typeof skills !== 'object') {
    return defaults;
  }

  const asSkills = skills as Record<string, unknown>;
  const load = asSkills['load'];
  const entries = asSkills['entries'];
  const install = asSkills['install'];

  const watch = typeof (load as Record<string, unknown> | undefined)?.['watch'] === 'boolean'
    ? Boolean((load as Record<string, unknown>)['watch'])
    : defaults.load.watch;

  const watchDebounceMs = parsePositiveInteger(
    String((load as Record<string, unknown> | undefined)?.['watchDebounceMs'] ?? ''),
    defaults.load.watchDebounceMs
  );

  const extraDirs = normalizeStringArray((load as Record<string, unknown> | undefined)?.['extraDirs']);
  const pluginDirsCandidate = normalizeStringArray((load as Record<string, unknown> | undefined)?.['pluginDirs']);
  const pluginDirs = pluginDirsCandidate.length > 0 ? pluginDirsCandidate : defaults.load.pluginDirs;

  const allowBundled = normalizeStringArray(asSkills['allowBundled']);
  const nodeManager = normalizeNodeManager((install as Record<string, unknown> | undefined)?.['nodeManager']);

  return {
    load: {
      watch,
      watchDebounceMs,
      extraDirs,
      pluginDirs,
    },
    entries: normalizeSkillEntries(entries),
    allowBundled: allowBundled.length > 0 ? allowBundled : undefined,
    install: {
      nodeManager,
    },
  };
}

export function loadPersistedPluginsConfig(
  parsedConfig: Record<string, unknown> | null = loadPersistedConfigObject()
): NonNullable<KeygateConfig['plugins']> {
  const defaults = buildDefaultPluginsConfig();
  const asPlugins = parsedConfig && typeof parsedConfig === 'object'
    && parsedConfig['plugins'] && typeof parsedConfig['plugins'] === 'object' && !Array.isArray(parsedConfig['plugins'])
    ? parsedConfig['plugins'] as Record<string, unknown>
    : {};
  const load = asPlugins['load'];
  const entries = asPlugins['entries'];
  const install = asPlugins['install'];

  const watch = typeof (load as Record<string, unknown> | undefined)?.['watch'] === 'boolean'
    ? Boolean((load as Record<string, unknown>)['watch'])
    : defaults.load.watch;

  const watchDebounceMs = parsePositiveInteger(
    String((load as Record<string, unknown> | undefined)?.['watchDebounceMs'] ?? ''),
    defaults.load.watchDebounceMs
  );

  const persistedPaths = normalizeStringArray((load as Record<string, unknown> | undefined)?.['paths']);
  const envPaths = parseBooleanEnv(process.env['KEYGATE_PLUGINS_WATCH']) === undefined
    ? undefined
    : parseBooleanEnv(process.env['KEYGATE_PLUGINS_WATCH']);
  const effectiveWatch = typeof envPaths === 'boolean' ? envPaths : watch;

  const envDebounceRaw = process.env['KEYGATE_PLUGINS_WATCH_DEBOUNCE_MS'];
  const effectiveDebounce = envDebounceRaw
    ? parsePositiveInteger(envDebounceRaw, watchDebounceMs)
    : watchDebounceMs;

  const envRoots = normalizeStringArray(
    typeof process.env['KEYGATE_PLUGINS_PATHS'] === 'string'
      ? process.env['KEYGATE_PLUGINS_PATHS']!.split(',')
      : []
  );
  const paths = envRoots.length > 0 ? envRoots : persistedPaths;
  const nodeManager = normalizeNodeManager(
    process.env['KEYGATE_PLUGINS_NODE_MANAGER'] ?? (install as Record<string, unknown> | undefined)?.['nodeManager'],
    DEFAULT_PLUGINS_NODE_MANAGER
  );

  return {
    load: {
      watch: effectiveWatch,
      watchDebounceMs: effectiveDebounce,
      paths,
    },
    entries: normalizePluginEntries(entries),
    install: {
      nodeManager,
    },
  };
}

export function loadPersistedWhatsAppConfig(
  parsedConfig: Record<string, unknown> | null = loadPersistedConfigObject()
): WhatsAppConfig {
  const defaults = buildDefaultWhatsAppConfig();

  if (!parsedConfig || typeof parsedConfig !== 'object') {
    return defaults;
  }

  const raw = parsedConfig['whatsapp'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaults;
  }

  const source = raw as Record<string, unknown>;
  return {
    dmPolicy: normalizeDmPolicy(typeof source['dmPolicy'] === 'string' ? source['dmPolicy'] : undefined),
    allowFrom: normalizeStringArray(source['allowFrom']),
    groupMode: normalizeWhatsAppGroupMode(source['groupMode']),
    groups: normalizeWhatsAppGroupRules(source['groups']),
    groupRequireMentionDefault:
      typeof source['groupRequireMentionDefault'] === 'boolean'
        ? source['groupRequireMentionDefault']
        : defaults.groupRequireMentionDefault,
    sendReadReceipts:
      typeof source['sendReadReceipts'] === 'boolean'
        ? source['sendReadReceipts']
        : defaults.sendReadReceipts,
  };
}

export function loadPersistedSandboxConfig(
  parsedConfig: Record<string, unknown> | null = loadPersistedConfigObject()
): KeygateConfig['security']['sandbox'] {
  const defaults = buildDefaultSandboxConfig();
  if (!parsedConfig || typeof parsedConfig !== 'object') {
    return defaults;
  }

  const rawSecurity = parsedConfig['security'];
  if (!rawSecurity || typeof rawSecurity !== 'object' || Array.isArray(rawSecurity)) {
    return defaults;
  }

  const rawSandbox = (rawSecurity as Record<string, unknown>)['sandbox'];
  if (!rawSandbox || typeof rawSandbox !== 'object' || Array.isArray(rawSandbox)) {
    return defaults;
  }

  const source = rawSandbox as Record<string, unknown>;
  return {
    backend: 'docker',
    scope: normalizeSandboxScope(source['scope']) ?? defaults.scope,
    image: typeof source['image'] === 'string' && source['image'].trim().length > 0
      ? source['image'].trim()
      : defaults.image,
    networkAccess: typeof source['networkAccess'] === 'boolean'
      ? source['networkAccess']
      : defaults.networkAccess,
    degradeWithoutDocker: typeof source['degradeWithoutDocker'] === 'boolean'
      ? source['degradeWithoutDocker']
      : defaults.degradeWithoutDocker,
  };
}

export function loadPersistedGmailConfig(
  parsedConfig: Record<string, unknown> | null = loadPersistedConfigObject()
): GmailConfig {
  const defaults = buildDefaultGmailConfig();
  if (!parsedConfig || typeof parsedConfig !== 'object') {
    return defaults;
  }

  const raw = parsedConfig['gmail'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaults;
  }

  const source = raw as Record<string, unknown>;
  const defaultsSource =
    source['defaults'] && typeof source['defaults'] === 'object' && !Array.isArray(source['defaults'])
      ? source['defaults'] as Record<string, unknown>
      : {};

  return {
    clientId: normalizeOptionalString(source['clientId']) ?? defaults.clientId,
    authorizationEndpoint:
      normalizeOptionalString(source['authorizationEndpoint']) ?? defaults.authorizationEndpoint,
    tokenEndpoint:
      normalizeOptionalString(source['tokenEndpoint']) ?? defaults.tokenEndpoint,
    redirectUri:
      normalizeOptionalString(source['redirectUri']) ?? defaults.redirectUri,
    redirectPort:
      Number.isFinite(toFiniteNumber(source['redirectPort']))
        ? Math.max(1, Math.floor(toFiniteNumber(source['redirectPort'])))
        : defaults.redirectPort,
    defaults: {
      projectId: normalizeOptionalString(defaultsSource['projectId']) ?? defaults.defaults.projectId,
      pubsubTopic: normalizeOptionalString(defaultsSource['pubsubTopic']) ?? defaults.defaults.pubsubTopic,
      pushBaseUrl: normalizeOptionalString(defaultsSource['pushBaseUrl']) ?? defaults.defaults.pushBaseUrl,
      pushPathSecret: normalizeOptionalString(defaultsSource['pushPathSecret']) ?? defaults.defaults.pushPathSecret,
      targetSessionId: normalizeOptionalString(defaultsSource['targetSessionId']) ?? defaults.defaults.targetSessionId,
      labelIds: normalizeStringArray(defaultsSource['labelIds']),
      promptPrefix: normalizeOptionalString(defaultsSource['promptPrefix']) ?? defaults.defaults.promptPrefix,
      watchRenewalMinutes:
        Number.isFinite(toFiniteNumber(defaultsSource['watchRenewalMinutes']))
          ? Math.max(5, Math.floor(toFiniteNumber(defaultsSource['watchRenewalMinutes'])))
          : defaults.defaults.watchRenewalMinutes,
    },
  };
}

export function loadPersistedPricingOverrides(
  parsedConfig: Record<string, unknown> | null = loadPersistedConfigObject()
): Record<string, LLMPricingOverride> {
  if (!parsedConfig || typeof parsedConfig !== 'object') {
    return {};
  }

  const rawLlm = parsedConfig['llm'];
  if (!rawLlm || typeof rawLlm !== 'object' || Array.isArray(rawLlm)) {
    return {};
  }

  const rawPricing = (rawLlm as Record<string, unknown>)['pricing'];
  if (!rawPricing || typeof rawPricing !== 'object' || Array.isArray(rawPricing)) {
    return {};
  }

  const rawOverrides = (rawPricing as Record<string, unknown>)['overrides'];
  if (!rawOverrides || typeof rawOverrides !== 'object' || Array.isArray(rawOverrides)) {
    return {};
  }

  const output: Record<string, LLMPricingOverride> = {};
  for (const [key, value] of Object.entries(rawOverrides as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    const source = value as Record<string, unknown>;
    const input = toFiniteNumber(source['inputPerMillionUsd']);
    const outputPrice = toFiniteNumber(source['outputPerMillionUsd']);
    const cached = toFiniteNumber(source['cachedInputPerMillionUsd']);
    if (!Number.isFinite(input) || !Number.isFinite(outputPrice)) {
      continue;
    }
    output[key] = {
      inputPerMillionUsd: input,
      outputPerMillionUsd: outputPrice,
      cachedInputPerMillionUsd: Number.isFinite(cached) ? cached : undefined,
    };
  }

  return output;
}

function buildDefaultSkillsConfig(): NonNullable<KeygateConfig['skills']> {
  return {
    load: {
      watch: DEFAULT_SKILLS_WATCH,
      watchDebounceMs: DEFAULT_SKILLS_WATCH_DEBOUNCE_MS,
      extraDirs: [],
      pluginDirs: [path.join(getConfigDir(), 'plugins')],
    },
    entries: {},
    install: {
      nodeManager: DEFAULT_SKILLS_NODE_MANAGER,
    },
  };
}

function buildDefaultPluginsConfig(): NonNullable<KeygateConfig['plugins']> {
  return {
    load: {
      watch: DEFAULT_PLUGINS_WATCH,
      watchDebounceMs: DEFAULT_PLUGINS_WATCH_DEBOUNCE_MS,
      paths: [],
    },
    entries: {},
    install: {
      nodeManager: DEFAULT_PLUGINS_NODE_MANAGER,
    },
  };
}

function buildDefaultWhatsAppConfig(): WhatsAppConfig {
  return {
    dmPolicy: DEFAULT_DM_POLICY,
    allowFrom: [],
    groupMode: DEFAULT_WHATSAPP_GROUP_MODE,
    groups: {},
    groupRequireMentionDefault: true,
    sendReadReceipts: true,
  };
}

function buildDefaultSandboxConfig(): KeygateConfig['security']['sandbox'] {
  return {
    backend: 'docker',
    scope: DEFAULT_SANDBOX_SCOPE,
    image: DEFAULT_SANDBOX_IMAGE,
    networkAccess: true,
    degradeWithoutDocker: true,
  };
}

function buildDefaultGmailConfig(): GmailConfig {
  return {
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    redirectPort: 1488,
    defaults: {
      labelIds: [],
      watchRenewalMinutes: 1_320,
    },
  };
}

function normalizeNodeManager(value: unknown, fallback: NodeManager = DEFAULT_SKILLS_NODE_MANAGER): NodeManager {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return normalized;
    default:
      return fallback;
  }
}

function normalizeSandboxScope(value: unknown): SandboxScope | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'session' || normalized === 'agent') {
    return normalized;
  }

  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function toFiniteNumber(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeWhatsAppGroupMode(value: unknown): WhatsAppGroupMode {
  if (typeof value !== 'string') {
    return DEFAULT_WHATSAPP_GROUP_MODE;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'open' || normalized === 'selected') {
    return normalized;
  }

  return DEFAULT_WHATSAPP_GROUP_MODE;
}

function normalizeWhatsAppGroupRules(value: unknown): WhatsAppConfig['groups'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: WhatsAppConfig['groups'] = {};
  for (const [groupKey, rawRule] of Object.entries(value as Record<string, unknown>)) {
    if (!groupKey.startsWith('group:')) {
      continue;
    }

    if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) {
      result[groupKey] = {};
      continue;
    }

    const rule = rawRule as Record<string, unknown>;
    result[groupKey] = {
      requireMention: typeof rule['requireMention'] === 'boolean' ? rule['requireMention'] : undefined,
      name: typeof rule['name'] === 'string' && rule['name'].trim().length > 0 ? rule['name'].trim() : undefined,
    };
  }

  return result;
}

function normalizeSkillEntries(value: unknown): Record<string, NonNullable<KeygateConfig['skills']>['entries'][string]> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, NonNullable<KeygateConfig['skills']>['entries'][string]> = {};

  for (const [key, rawEntry] of Object.entries(source)) {
    if (!rawEntry || typeof rawEntry !== 'object') {
      continue;
    }

    const entry = rawEntry as Record<string, unknown>;
    const normalizedEnv = normalizeEnvMap(entry['env']);
    const normalizedConfig = normalizeConfigBag(entry['config']);

    result[key] = {
      enabled: typeof entry['enabled'] === 'boolean' ? entry['enabled'] : undefined,
      apiKey: typeof entry['apiKey'] === 'string' ? entry['apiKey'] : undefined,
      env: Object.keys(normalizedEnv).length > 0 ? normalizedEnv : undefined,
      config: Object.keys(normalizedConfig).length > 0 ? normalizedConfig : undefined,
    };
  }

  return result;
}

function normalizePluginEntries(value: unknown): Record<string, PluginEntryConfig> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, PluginEntryConfig> = {};

  for (const [key, rawEntry] of Object.entries(source)) {
    if (!rawEntry || typeof rawEntry !== 'object') {
      continue;
    }

    const entry = rawEntry as Record<string, unknown>;
    const normalizedEnv = normalizeEnvMap(entry['env']);
    const normalizedConfig = normalizeConfigBag(entry['config']);

    result[key] = {
      enabled: typeof entry['enabled'] === 'boolean' ? entry['enabled'] : undefined,
      env: Object.keys(normalizedEnv).length > 0 ? normalizedEnv : undefined,
      config: Object.keys(normalizedConfig).length > 0 ? normalizedConfig : undefined,
    };
  }

  return result;
}

function loadPersistedServerApiToken(parsedConfig: Record<string, unknown>): string {
  const server = parsedConfig['server'];
  if (!server || typeof server !== 'object' || Array.isArray(server)) {
    return '';
  }

  const apiToken = (server as Record<string, unknown>)['apiToken'];
  return typeof apiToken === 'string' ? apiToken : '';
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return undefined;
}

function normalizeEnvMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') {
      output[key] = raw;
    }
  }

  return output;
}

function normalizeConfigBag(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  return value as Record<string, unknown>;
}
