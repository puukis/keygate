import path from 'node:path';
import { promises as fs } from 'node:fs';
import { getConfigDir } from '../config/env.js';

const TOKEN_FILE = 'openai-oauth-tokens.json';
const EXPIRY_SKEW_SECONDS = 60;

export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // Unix epoch seconds
  account_id?: string;
  scope?: string;
}

let fileLock: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = fileLock.then(fn, fn);
  fileLock = next.then(() => {}, () => {});
  return next;
}

function getTokenFilePath(): string {
  return path.join(getConfigDir(), TOKEN_FILE);
}

export async function readTokens(): Promise<StoredTokens | null> {
  const tokenPath = getTokenFilePath();

  try {
    const raw = await fs.readFile(tokenPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    if (typeof record['access_token'] !== 'string' || typeof record['expires_at'] !== 'number') {
      return null;
    }

    return {
      access_token: record['access_token'] as string,
      refresh_token: typeof record['refresh_token'] === 'string' ? record['refresh_token'] as string : undefined,
      expires_at: record['expires_at'] as number,
      account_id: typeof record['account_id'] === 'string' ? record['account_id'] as string : undefined,
      scope: typeof record['scope'] === 'string' ? record['scope'] as string : undefined,
    };
  } catch {
    return null;
  }
}

export async function writeTokens(tokens: StoredTokens): Promise<void> {
  return withLock(async () => {
    const tokenPath = getTokenFilePath();
    await fs.mkdir(path.dirname(tokenPath), { recursive: true });

    const data = JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at,
      account_id: tokens.account_id,
      scope: tokens.scope,
    }, null, 2);

    await fs.writeFile(tokenPath, data, { encoding: 'utf8', mode: 0o600 });
  });
}

export async function deleteTokens(): Promise<void> {
  return withLock(async () => {
    const tokenPath = getTokenFilePath();
    try {
      await fs.unlink(tokenPath);
    } catch {
      // Already deleted or never existed.
    }
  });
}

export function isTokenExpired(tokens: StoredTokens): boolean {
  const now = Math.floor(Date.now() / 1000);
  return now >= tokens.expires_at - EXPIRY_SKEW_SECONDS;
}

export async function getValidAccessToken(
  tokenEndpoint: string,
  clientId: string
): Promise<string> {
  const tokens = await readTokens();

  if (!tokens) {
    throw new Error('Not logged in. Run `keygate auth login --provider openai-codex` first.');
  }

  if (!isTokenExpired(tokens)) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    throw new Error('Token expired and no refresh token available. Please login again.');
  }

  return refreshAccessToken(tokenEndpoint, clientId, tokens.refresh_token);
}

export async function refreshAccessToken(
  tokenEndpoint: string,
  clientId: string,
  refreshToken: string
): Promise<string> {
  return withLock(async () => {
    // Re-read in case another caller already refreshed.
    const current = await readTokens();
    if (current && !isTokenExpired(current)) {
      return current.access_token;
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
    });

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      await deleteTokens();
      throw new Error(
        `Token refresh failed (${response.status}). Please login again.${text ? ` Response: ${text}` : ''}`
      );
    }

    const result = (await response.json()) as Record<string, unknown>;

    const accessToken = result['access_token'];
    const newRefreshToken = result['refresh_token'];
    const expiresIn = result['expires_in'];

    if (typeof accessToken !== 'string') {
      throw new Error('Token refresh response missing access_token');
    }

    const expiresAt = Math.floor(Date.now() / 1000) +
      (typeof expiresIn === 'number' ? expiresIn : 3600);

    const updated: StoredTokens = {
      access_token: accessToken,
      refresh_token: typeof newRefreshToken === 'string' ? newRefreshToken : refreshToken,
      expires_at: expiresAt,
      account_id: current?.account_id,
      scope: current?.scope,
    };

    await writeTokens(updated);
    return accessToken;
  });
}
