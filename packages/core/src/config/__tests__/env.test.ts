import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import dotenv from 'dotenv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getConfigDir,
  getConfigHomeDir,
  getDefaultWorkspacePath,
  getKeygateFilePath,
  getLegacyConfigDir,
  getLegacyKeygateEnvPath,
  getPreferredConfigDir,
  getPreferredKeygateEnvPath,
  loadConfigFromEnv,
  loadEnvironment,
  savePersistedConfigObject,
  updateKeygateFile,
} from '../env.js';

describe('loadConfigFromEnv', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-home-'));

    if (process.platform === 'win32') {
      vi.stubEnv('USERPROFILE', tempHome);
      vi.stubEnv('APPDATA', path.join(tempHome, 'AppData', 'Roaming'));
      return;
    }

    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(tempHome, '.config'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('resolves the preferred config root and env path', () => {
    expect(getPreferredConfigDir()).toBe(path.join(tempHome, '.keygate'));
    expect(getPreferredKeygateEnvPath()).toBe(path.join(tempHome, '.keygate', '.env'));
    expect(getConfigDir()).toBe(getPreferredConfigDir());
    expect(getKeygateFilePath()).toBe(getPreferredKeygateEnvPath());

    if (process.platform === 'win32') {
      expect(getConfigHomeDir()).toBe(path.join(tempHome, 'AppData', 'Roaming'));
      expect(getLegacyConfigDir()).toBe(path.join(tempHome, 'AppData', 'Roaming', 'keygate'));
      expect(getLegacyKeygateEnvPath()).toBe(
        path.join(tempHome, 'AppData', 'Roaming', 'keygate', '.keygate')
      );
      return;
    }

    expect(getConfigHomeDir()).toBe(path.join(tempHome, '.config'));
    expect(getLegacyConfigDir()).toBe(path.join(tempHome, '.config', 'keygate'));
    expect(getLegacyKeygateEnvPath()).toBe(path.join(tempHome, '.config', 'keygate', '.keygate'));
  });

  it('loads the preferred env file, the legacy filename, and cwd .keygate', () => {
    const configSpy = vi.spyOn(dotenv, 'config').mockReturnValue({} as any);

    loadEnvironment();

    expect(configSpy).toHaveBeenCalledTimes(3);
    expect(configSpy).toHaveBeenNthCalledWith(1, { path: path.join(getConfigDir(), '.env') });
    expect(configSpy).toHaveBeenNthCalledWith(2, { path: path.join(getConfigDir(), '.keygate') });
    expect(configSpy).toHaveBeenNthCalledWith(3, { path: path.resolve(process.cwd(), '.keygate') });
  });

  it('migrates a legacy config tree into the preferred root', async () => {
    const legacyDir = getLegacyConfigDir();
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, '.keygate'), 'LLM_PROVIDER=openai-codex\n', 'utf8');
    await fs.writeFile(
      path.join(legacyDir, 'config.json'),
      JSON.stringify({ server: { apiToken: 'copied-token' } }, null, 2),
      'utf8'
    );

    expect(getConfigDir()).toBe(getPreferredConfigDir());
    await expect(fs.readFile(getPreferredKeygateEnvPath(), 'utf8')).resolves.toContain(
      'LLM_PROVIDER=openai-codex'
    );
    await expect(fs.readFile(path.join(getPreferredConfigDir(), 'config.json'), 'utf8')).resolves.toContain(
      'copied-token'
    );
  });

  it('hydrates a partially initialized preferred root from the legacy config tree', async () => {
    const preferredDir = getPreferredConfigDir();
    const legacyDir = getLegacyConfigDir();

    await fs.mkdir(preferredDir, { recursive: true });
    await fs.writeFile(path.join(preferredDir, 'allowed_commands.json'), '{"version":1,"commands":[]}\n', 'utf8');
    await fs.writeFile(path.join(preferredDir, 'codex-models-cache.json'), '[]\n', 'utf8');

    await fs.mkdir(path.join(legacyDir, 'channels', 'whatsapp'), { recursive: true });
    await fs.writeFile(path.join(legacyDir, '.keygate'), 'LLM_PROVIDER=openai-codex\n', 'utf8');
    await fs.writeFile(
      path.join(legacyDir, 'config.json'),
      JSON.stringify({ server: { apiToken: 'merged-token' } }, null, 2),
      'utf8'
    );
    await fs.writeFile(path.join(legacyDir, 'channels', 'whatsapp', 'meta.json'), '{"jid":"x"}\n', 'utf8');

    expect(getConfigDir()).toBe(preferredDir);
    await expect(fs.readFile(getPreferredKeygateEnvPath(), 'utf8')).resolves.toContain(
      'LLM_PROVIDER=openai-codex'
    );
    await expect(fs.readFile(path.join(preferredDir, 'config.json'), 'utf8')).resolves.toContain('merged-token');
    await expect(
      fs.readFile(path.join(preferredDir, 'channels', 'whatsapp', 'meta.json'), 'utf8')
    ).resolves.toContain('"jid":"x"');
    await expect(fs.readFile(path.join(preferredDir, 'allowed_commands.json'), 'utf8')).resolves.toContain(
      '"version":1'
    );
  });

  it('falls back to the legacy root when migration fails', async () => {
    const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const legacyDir = getLegacyConfigDir();
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(getPreferredConfigDir()), 'occupied', 'utf8');

    expect(getConfigDir()).toBe(legacyDir);
    expect(getKeygateFilePath()).toBe(getLegacyKeygateEnvPath());
    expect(warningSpy).toHaveBeenCalledTimes(1);
  });

  it('promotes a legacy-named env file in the preferred root on write', async () => {
    const preferredDir = getPreferredConfigDir();
    const legacyNamedEnvPath = path.join(preferredDir, '.keygate');
    await fs.mkdir(preferredDir, { recursive: true });
    await fs.writeFile(legacyNamedEnvPath, 'LLM_PROVIDER=openai\n', 'utf8');

    await updateKeygateFile({ LLM_MODEL: 'gpt-4o' });

    const content = await fs.readFile(getPreferredKeygateEnvPath(), 'utf8');
    expect(content).toContain('LLM_PROVIDER=openai');
    expect(content).toContain('LLM_MODEL=gpt-4o');
    await expect(fs.access(legacyNamedEnvPath)).rejects.toThrow();
  });

  it('defaults spicy max obedience to false when unset', () => {
    vi.stubEnv('SPICY_MODE_ENABLED', 'true');
    vi.stubEnv('SPICY_MAX_OBEDIENCE_ENABLED', '');

    const config = loadConfigFromEnv();

    expect(config.security.spicyModeEnabled).toBe(true);
    expect(config.security.spicyMaxObedienceEnabled).toBe(false);
  });

  it('enables spicy max obedience when explicitly set and spicy mode is enabled', () => {
    vi.stubEnv('SPICY_MODE_ENABLED', 'true');
    vi.stubEnv('SPICY_MAX_OBEDIENCE_ENABLED', 'true');

    const config = loadConfigFromEnv();

    expect(config.security.spicyMaxObedienceEnabled).toBe(true);
  });

  it('keeps spicy max obedience disabled when spicy mode itself is disabled', () => {
    vi.stubEnv('SPICY_MODE_ENABLED', 'false');
    vi.stubEnv('SPICY_MAX_OBEDIENCE_ENABLED', 'true');

    const config = loadConfigFromEnv();

    expect(config.security.spicyModeEnabled).toBe(false);
    expect(config.security.spicyMaxObedienceEnabled).toBe(false);
  });

  it('normalizes comma-separated discord prefixes', () => {
    vi.stubEnv('DISCORD_PREFIX', '1, 2,3 , 4');

    const config = loadConfigFromEnv();

    expect(config.discord?.prefix).toBe('1, 2, 3, 4');
  });

  it('applies default browser config values when env is unset', () => {
    const config = loadConfigFromEnv();

    expect(config.browser.domainPolicy).toBe('none');
    expect(config.browser.domainAllowlist).toEqual([]);
    expect(config.browser.domainBlocklist).toEqual([]);
    expect(config.browser.traceRetentionDays).toBe(7);
    expect(config.browser.mcpPlaywrightVersion).toBe('0.0.64');
    expect(config.browser.artifactsPath).toContain('.keygate-browser-runs');
    expect(config.skills?.load.watch).toBe(true);
    expect(config.skills?.load.watchDebounceMs).toBe(250);
    expect(config.skills?.load.extraDirs).toEqual([]);
    expect(Array.isArray(config.skills?.load.pluginDirs)).toBe(true);
    expect(config.skills?.install.nodeManager).toBe('npm');
  });

  it('parses browser policy values from environment', () => {
    vi.stubEnv('BROWSER_DOMAIN_POLICY', 'allowlist');
    vi.stubEnv('BROWSER_DOMAIN_ALLOWLIST', 'https://example.com, https://docs.example.com');
    vi.stubEnv('BROWSER_DOMAIN_BLOCKLIST', 'https://evil.com, , https://ads.example');
    vi.stubEnv('BROWSER_TRACE_RETENTION_DAYS', '14');
    vi.stubEnv('MCP_PLAYWRIGHT_VERSION', '0.0.99');

    const config = loadConfigFromEnv();

    expect(config.browser.domainPolicy).toBe('allowlist');
    expect(config.browser.domainAllowlist).toEqual([
      'https://example.com',
      'https://docs.example.com',
    ]);
    expect(config.browser.domainBlocklist).toEqual([
      'https://evil.com',
      'https://ads.example',
    ]);
    expect(config.browser.traceRetentionDays).toBe(14);
    expect(config.browser.mcpPlaywrightVersion).toBe('0.0.99');
  });

  it('parses DM trust policy values from environment', () => {
    vi.stubEnv('DISCORD_DM_POLICY', 'closed');
    vi.stubEnv('DISCORD_ALLOW_FROM', '123,456');
    vi.stubEnv('SLACK_DM_POLICY', 'open');
    vi.stubEnv('SLACK_ALLOW_FROM', 'U1, U2');

    const config = loadConfigFromEnv();

    expect(config.discord?.dmPolicy).toBe('closed');
    expect(config.discord?.allowFrom).toEqual(['123', '456']);
    expect(config.slack?.dmPolicy).toBe('open');
    expect(config.slack?.allowFrom).toEqual(['U1', 'U2']);
  });

  it('reads persisted skills config from config.json', async () => {
    const configDir = path.dirname(getKeygateFilePath());
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        skills: {
          load: {
            watch: false,
            watchDebounceMs: 777,
            extraDirs: ['/tmp/skills-extra'],
            pluginDirs: ['/tmp/keygate-plugins'],
          },
          allowBundled: ['repo-triage'],
          install: { nodeManager: 'pnpm' },
          entries: {
            'repo-triage': {
              enabled: true,
              apiKey: 'abc',
              env: { TEST_ENV: '1' },
              config: { endpoint: 'x' },
            },
          },
        },
      }),
      'utf8'
    );

    const config = loadConfigFromEnv();
    expect(config.skills?.load.watch).toBe(false);
    expect(config.skills?.load.watchDebounceMs).toBe(777);
    expect(config.skills?.load.extraDirs).toEqual(['/tmp/skills-extra']);
    expect(config.skills?.load.pluginDirs).toEqual(['/tmp/keygate-plugins']);
    expect(config.skills?.allowBundled).toEqual(['repo-triage']);
    expect(config.skills?.install.nodeManager).toBe('pnpm');
    expect(config.skills?.entries['repo-triage']?.env?.['TEST_ENV']).toBe('1');
  });

  it('loads default whatsapp config when config.json omits it', () => {
    const config = loadConfigFromEnv();

    expect(config.whatsapp).toEqual({
      dmPolicy: 'pairing',
      allowFrom: [],
      groupMode: 'closed',
      groups: {},
      groupRequireMentionDefault: true,
      sendReadReceipts: true,
    });
  });

  it('normalizes the legacy config-root workspace path to the new default workspace', () => {
    vi.stubEnv(
      'WORKSPACE_PATH',
      path.join(getLegacyConfigDir(), 'workspaces', path.basename(getDefaultWorkspacePath()))
    );

    const config = loadConfigFromEnv();

    expect(config.security.workspacePath).toBe(getDefaultWorkspacePath());
  });

  it('persists whatsapp config without overwriting skills config', async () => {
    const configDir = path.dirname(getKeygateFilePath());
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        skills: {
          load: {
            watch: true,
            watchDebounceMs: 333,
            extraDirs: [],
            pluginDirs: ['/tmp/plug'],
          },
          entries: {},
          install: { nodeManager: 'npm' },
        },
      }),
      'utf8'
    );

    await savePersistedConfigObject((current) => ({
      ...current,
      whatsapp: {
        dmPolicy: 'closed',
        allowFrom: ['+15551234567'],
        groupMode: 'selected',
        groups: {
          'group:123': { requireMention: false },
        },
        groupRequireMentionDefault: false,
        sendReadReceipts: false,
      },
    }));

    const config = loadConfigFromEnv();
    expect(config.skills?.load.watchDebounceMs).toBe(333);
    expect(config.whatsapp?.dmPolicy).toBe('closed');
    expect(config.whatsapp?.groups).toEqual({
      'group:123': { requireMention: false, name: undefined },
    });
    expect(config.whatsapp?.sendReadReceipts).toBe(false);
  });
});
