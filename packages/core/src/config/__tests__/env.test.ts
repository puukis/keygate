import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfigFromEnv } from '../env.js';

describe('loadConfigFromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
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
});
