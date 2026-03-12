import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { writeTokens, readTokens, deleteTokens, isTokenExpired, type StoredTokens } from '../tokenStore.js';
import { getConfigDir } from '../../config/env.js';
import { __setKeytarLoaderForTests } from '../secretStore.js';

const TOKEN_FILE = 'openai-oauth-tokens.json';
let testDir = '';

describe('tokenStore', () => {
  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-auth-test-'));
    vi.unstubAllEnvs();
    vi.stubEnv('HOME', testDir);
    vi.stubEnv('USERPROFILE', testDir);
    vi.stubEnv('XDG_CONFIG_HOME', testDir);
    vi.stubEnv('KEYGATE_TOKEN_STORE', 'file');
    __setKeytarLoaderForTests(null);
  });

  afterEach(async () => {
    __setKeytarLoaderForTests(null);
    vi.unstubAllEnvs();
    try {
      await fs.rm(testDir, { recursive: true, force: true });
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

  it('stores tokens in keychain mode and keeps metadata in file', async () => {
    const keytar = createMockKeytar();
    __setKeytarLoaderForTests(async () => keytar);
    vi.stubEnv('KEYGATE_TOKEN_STORE', 'keychain');

    const tokens: StoredTokens = {
      access_token: 'keychain-access',
      refresh_token: 'keychain-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 7200,
      account_id: 'acct-keychain',
      scope: 'openai.chat',
    };

    await writeTokens(tokens);

    const rawRecord = await readTokenRecord();
    expect(rawRecord?.storage_mode).toBe('keychain');
    expect(rawRecord?.access_token).toBeUndefined();
    expect(rawRecord?.refresh_token).toBeUndefined();
    expect(keytar.secrets.size).toBe(2);

    const loaded = await readTokens();
    expect(loaded?.access_token).toBe('keychain-access');
    expect(loaded?.refresh_token).toBe('keychain-refresh');
    expect(loaded?.storage_mode).toBe('keychain');
  });

  it('falls back to file storage when keychain is unavailable in auto mode', async () => {
    __setKeytarLoaderForTests(async () => null);
    vi.stubEnv('KEYGATE_TOKEN_STORE', 'auto');

    await writeTokens({
      access_token: 'file-access',
      refresh_token: 'file-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    const rawRecord = await readTokenRecord();
    expect(rawRecord?.storage_mode).toBe('file');
    expect(rawRecord?.access_token).toBe('file-access');
    expect(rawRecord?.refresh_token).toBe('file-refresh');

    const loaded = await readTokens();
    expect(loaded?.storage_mode).toBe('file');
    expect(loaded?.access_token).toBe('file-access');
  });

  it('migrates a legacy token file to keychain in auto mode', async () => {
    const keytar = createMockKeytar();
    __setKeytarLoaderForTests(async () => keytar);
    vi.stubEnv('KEYGATE_TOKEN_STORE', 'auto');

    await writeTokenRecord({
      access_token: 'legacy-access',
      refresh_token: 'legacy-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      account_id: 'legacy-account',
      scope: 'openai.chat',
    });

    const loaded = await readTokens();
    expect(loaded?.access_token).toBe('legacy-access');
    expect(loaded?.refresh_token).toBe('legacy-refresh');
    expect(loaded?.storage_mode).toBe('keychain');

    const rawRecord = await readTokenRecord();
    expect(rawRecord?.storage_mode).toBe('keychain');
    expect(rawRecord?.access_token).toBeUndefined();
    expect(rawRecord?.refresh_token).toBeUndefined();
    expect(keytar.secrets.size).toBe(2);
  });

  it('keychain disable override forces file storage', async () => {
    const keytar = createMockKeytar();
    __setKeytarLoaderForTests(async () => keytar);
    vi.stubEnv('KEYGATE_TOKEN_STORE', 'keychain');
    vi.stubEnv('KEYGATE_DISABLE_KEYCHAIN', 'true');

    await writeTokens({
      access_token: 'forced-file-access',
      refresh_token: 'forced-file-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    const rawRecord = await readTokenRecord();
    expect(rawRecord?.storage_mode).toBe('file');
    expect(rawRecord?.access_token).toBe('forced-file-access');
    expect(keytar.secrets.size).toBe(0);
  });

  it('migrates existing file-backed tokens into keychain mode when keychain becomes available', async () => {
    vi.stubEnv('KEYGATE_TOKEN_STORE', 'file');
    await writeTokens({
      access_token: 'existing-file-access',
      refresh_token: 'existing-file-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    const keytar = createMockKeytar();
    __setKeytarLoaderForTests(async () => keytar);
    vi.stubEnv('KEYGATE_TOKEN_STORE', 'keychain');

    const loaded = await readTokens();
    expect(loaded?.storage_mode).toBe('keychain');
    expect(loaded?.access_token).toBe('existing-file-access');
    expect(loaded?.refresh_token).toBe('existing-file-refresh');

    const rawRecord = await readTokenRecord();
    expect(rawRecord?.storage_mode).toBe('keychain');
    expect(rawRecord?.access_token).toBeUndefined();
    expect(rawRecord?.refresh_token).toBeUndefined();
    expect(keytar.secrets.size).toBe(2);
  });

  it('reads existing file-backed tokens when keychain mode is configured but unavailable', async () => {
    vi.stubEnv('KEYGATE_TOKEN_STORE', 'file');
    await writeTokens({
      access_token: 'existing-file-access',
      refresh_token: 'existing-file-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    __setKeytarLoaderForTests(async () => null);
    vi.stubEnv('KEYGATE_TOKEN_STORE', 'keychain');

    const loaded = await readTokens();
    expect(loaded?.storage_mode).toBe('file');
    expect(loaded?.access_token).toBe('existing-file-access');
    expect(loaded?.refresh_token).toBe('existing-file-refresh');
  });

  it('updates existing file-backed tokens when keychain mode is configured but unavailable', async () => {
    vi.stubEnv('KEYGATE_TOKEN_STORE', 'file');
    await writeTokens({
      access_token: 'existing-file-access',
      refresh_token: 'existing-file-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    __setKeytarLoaderForTests(async () => null);
    vi.stubEnv('KEYGATE_TOKEN_STORE', 'keychain');

    await writeTokens({
      access_token: 'updated-file-access',
      refresh_token: 'updated-file-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 7200,
    });

    const rawRecord = await readTokenRecord();
    expect(rawRecord?.storage_mode).toBe('file');
    expect(rawRecord?.access_token).toBe('updated-file-access');
    expect(rawRecord?.refresh_token).toBe('updated-file-refresh');
  });

  it('reads legacy inline tokens when keychain mode is configured but unavailable', async () => {
    await writeTokenRecord({
      access_token: 'legacy-file-access',
      refresh_token: 'legacy-file-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    __setKeytarLoaderForTests(async () => null);
    vi.stubEnv('KEYGATE_TOKEN_STORE', 'keychain');

    const loaded = await readTokens();
    expect(loaded?.storage_mode).toBe('file');
    expect(loaded?.access_token).toBe('legacy-file-access');
    expect(loaded?.refresh_token).toBe('legacy-file-refresh');

    const rawRecord = await readTokenRecord();
    expect(rawRecord?.storage_mode).toBe('file');
    expect(rawRecord?.access_token).toBe('legacy-file-access');
    expect(rawRecord?.refresh_token).toBe('legacy-file-refresh');
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

  it('deletes active keychain secrets on logout', async () => {
    const keytar = createMockKeytar();
    __setKeytarLoaderForTests(async () => keytar);
    vi.stubEnv('KEYGATE_TOKEN_STORE', 'keychain');

    await writeTokens({
      access_token: 'to-delete-keychain',
      refresh_token: 'to-delete-keychain-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    expect(keytar.secrets.size).toBe(2);
    await deleteTokens();
    expect(keytar.secrets.size).toBe(0);

    const rawRecord = await readTokenRecord();
    expect(rawRecord).toBeNull();
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

function tokenFilePath(): string {
  return path.join(getConfigDir(), TOKEN_FILE);
}

async function readTokenRecord(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(tokenFilePath(), 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function writeTokenRecord(record: Record<string, unknown>): Promise<void> {
  const filePath = tokenFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(record, null, 2), 'utf8');
}

function createMockKeytar(): {
  getPassword: ReturnType<typeof vi.fn>;
  setPassword: ReturnType<typeof vi.fn>;
  deletePassword: ReturnType<typeof vi.fn>;
  secrets: Map<string, string>;
} {
  const secrets = new Map<string, string>();
  const keyFor = (service: string, account: string): string => `${service}::${account}`;

  const getPassword = vi.fn(async (service: string, account: string) => {
    return secrets.get(keyFor(service, account)) ?? null;
  });
  const setPassword = vi.fn(async (service: string, account: string, password: string) => {
    secrets.set(keyFor(service, account), password);
  });
  const deletePassword = vi.fn(async (service: string, account: string) => {
    return secrets.delete(keyFor(service, account));
  });

  return {
    getPassword,
    setPassword,
    deletePassword,
    secrets,
  };
}
