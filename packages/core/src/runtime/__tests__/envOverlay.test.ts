import { describe, expect, it } from 'vitest';
import { buildToolProcessEnv, getEnvOverlay, getEnvValue, withEnvOverlay } from '../envOverlay.js';

describe('env overlay runtime', () => {
  it('applies overlay only inside async context', async () => {
    const key = 'KEYGATE_TEST_ENV_OVERLAY';
    delete process.env[key];

    expect(getEnvValue(key)).toBeUndefined();

    const observed = await withEnvOverlay({ [key]: 'value-1' }, async () => {
      expect(getEnvValue(key)).toBe('value-1');
      const env = buildToolProcessEnv();
      expect(env[key]).toBe('value-1');
      return getEnvOverlay()[key];
    });

    expect(observed).toBe('value-1');
    expect(getEnvValue(key)).toBeUndefined();
  });

  it('keeps overlays isolated across concurrent runs', async () => {
    const key = 'KEYGATE_TEST_ENV_OVERLAY_CONCURRENT';
    delete process.env[key];

    const [a, b] = await Promise.all([
      withEnvOverlay({ [key]: 'A' }, async () => getEnvValue(key)),
      withEnvOverlay({ [key]: 'B' }, async () => getEnvValue(key)),
    ]);

    expect(new Set([a, b])).toEqual(new Set(['A', 'B']));
    expect(getEnvValue(key)).toBeUndefined();
  });
});
