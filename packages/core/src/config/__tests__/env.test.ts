import path from 'node:path';
import dotenv from 'dotenv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getKeygateFilePath, loadConfigFromEnv, loadEnvironment } from '../env.js';

describe('loadConfigFromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('resolves the config file path to .keygate', () => {
    if (process.platform === 'win32') {
      vi.stubEnv('APPDATA', path.join('C:\\', 'Users', 'tester', 'AppData', 'Roaming'));
      expect(getKeygateFilePath()).toBe(path.join('C:\\', 'Users', 'tester', 'AppData', 'Roaming', 'keygate', '.keygate'));
      return;
    }

    vi.stubEnv('XDG_CONFIG_HOME', '/tmp/keygate-xdg');
    expect(getKeygateFilePath()).toBe('/tmp/keygate-xdg/keygate/.keygate');
  });

  it('loads only .keygate files from config dir and cwd', () => {
    const configSpy = vi.spyOn(dotenv, 'config').mockReturnValue({} as any);

    if (process.platform === 'win32') {
      vi.stubEnv('APPDATA', path.join('C:\\', 'Users', 'tester', 'AppData', 'Roaming'));
    } else {
      vi.stubEnv('XDG_CONFIG_HOME', '/tmp/keygate-xdg');
    }

    loadEnvironment();

    expect(configSpy).toHaveBeenCalledTimes(2);
    expect(configSpy).toHaveBeenNthCalledWith(1, { path: getKeygateFilePath() });
    expect(configSpy).toHaveBeenNthCalledWith(2, { path: path.resolve(process.cwd(), '.keygate') });
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
});
