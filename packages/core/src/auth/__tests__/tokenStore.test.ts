import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { writeTokens, readTokens, deleteTokens, isTokenExpired, type StoredTokens } from '../tokenStore.js';

const TEST_DIR = path.join(os.tmpdir(), `keygate-auth-test-${Date.now()}`);

describe('tokenStore', () => {
  beforeEach(async () => {
    vi.stubEnv('XDG_CONFIG_HOME', TEST_DIR);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Cleanup best-effort.
    }
  });

  it('returns null when no tokens exist', async () => {
    const tokens = await readTokens();
    expect(tokens).toBeNull();
  });

  it('writes and reads tokens', async () => {
    const tokens: StoredTokens = {
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      account_id: 'test-account',
    };

    await writeTokens(tokens);
    const loaded = await readTokens();

    expect(loaded).not.toBeNull();
    expect(loaded!.access_token).toBe('test-access-token');
    expect(loaded!.refresh_token).toBe('test-refresh-token');
    expect(loaded!.account_id).toBe('test-account');
  });

  it('deletes tokens', async () => {
    await writeTokens({
      access_token: 'to-delete',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    await deleteTokens();
    const loaded = await readTokens();
    expect(loaded).toBeNull();
  });

  it('delete is idempotent', async () => {
    await expect(deleteTokens()).resolves.toBeUndefined();
  });
});

describe('isTokenExpired', () => {
  it('returns false for a token expiring in the future', () => {
    const tokens: StoredTokens = {
      access_token: 'test',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    };
    expect(isTokenExpired(tokens)).toBe(false);
  });

  it('returns true for an expired token', () => {
    const tokens: StoredTokens = {
      access_token: 'test',
      expires_at: Math.floor(Date.now() / 1000) - 100,
    };
    expect(isTokenExpired(tokens)).toBe(true);
  });

  it('returns true within 60s skew window', () => {
    const tokens: StoredTokens = {
      access_token: 'test',
      expires_at: Math.floor(Date.now() / 1000) + 30,
    };
    expect(isTokenExpired(tokens)).toBe(true);
  });
});
