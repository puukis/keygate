import path from 'node:path';
import { promises as fs } from 'node:fs';
import { getConfigDir } from '../config/env.js';
import {
  isTruthyEnvValue,
  resolveSecretStore,
  resolveTokenStoreMode,
  type SecretStoreBackend,
  type StoredTokenSecrets,
} from './secretStore.js';

const DEFAULT_TOKEN_NAMESPACE = 'openai-codex';
const TOKEN_FILES: Record<string, string> = {
  'openai-codex': 'openai-oauth-tokens.json',
  gmail: 'gmail-oauth-tokens.json',
};
const TOKEN_STORE_VERSION = 2;
const EXPIRY_SKEW_SECONDS = 60;

export interface TokenStoreLocation {
  namespace?: string;
  tokenFilePath?: string;
}

export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // Unix epoch seconds
  account_id?: string;
  scope?: string;
  storage_mode?: SecretStoreBackend;
}

interface TokenMetadata {
  expires_at: number;
  account_id?: string;
  scope?: string;
}

interface TokenFileRecord {
  version?: number;
  storage_mode?: SecretStoreBackend;
  expires_at?: number;
  account_id?: string;
  scope?: string;
  access_token?: string;
  refresh_token?: string;
}

let fileLock: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = fileLock.then(fn, fn);
  fileLock = next.then(() => {}, () => {});
  return next;
}

function getTokenFilePath(location?: TokenStoreLocation | string): string {
  const resolved = resolveTokenStoreLocation(location);
  if (resolved.tokenFilePath) {
    return resolved.tokenFilePath;
  }

  const filename = TOKEN_FILES[resolved.namespace] ?? `${sanitizeNamespace(resolved.namespace)}-oauth-tokens.json`;
  return path.join(getConfigDir(), filename);
}

export async function readTokens(location?: TokenStoreLocation | string): Promise<StoredTokens | null> {
  return readTokensInternal(getTokenFilePath(location));
}

export async function writeTokens(tokens: StoredTokens, location?: TokenStoreLocation | string): Promise<void> {
  return withLock(async () => {
    await writeTokensInternal(tokens, getTokenFilePath(location));
  });
}

export async function deleteTokens(location?: TokenStoreLocation | string): Promise<void> {
  return withLock(async () => {
    await deleteTokensInternal(getTokenFilePath(location));
  });
}

export function isTokenExpired(tokens: StoredTokens): boolean {
  const now = Math.floor(Date.now() / 1000);
  return now >= tokens.expires_at - EXPIRY_SKEW_SECONDS;
}

export async function getValidAccessToken(
  tokenEndpoint: string,
  clientId: string,
  location?: TokenStoreLocation | string,
  clientSecret?: string
): Promise<string> {
  const tokenPath = getTokenFilePath(location);
  const tokens = await readTokensInternal(tokenPath);

  if (!tokens) {
    throw new Error('Not logged in. Run `keygate auth login --provider openai-codex` first.');
  }

  if (!isTokenExpired(tokens)) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    throw new Error('Token expired and no refresh token available. Please login again.');
  }

  return refreshAccessToken(tokenEndpoint, clientId, tokens.refresh_token, location, clientSecret);
}

export async function refreshAccessToken(
  tokenEndpoint: string,
  clientId: string,
  refreshToken: string,
  location?: TokenStoreLocation | string,
  clientSecret?: string
): Promise<string> {
  const tokenPath = getTokenFilePath(location);
  return withLock(async () => {
    // Re-read in case another caller already refreshed.
    const current = await readTokensInternal(tokenPath);
    if (current && !isTokenExpired(current)) {
      return current.access_token;
    }

    const effectiveRefreshToken = current?.refresh_token ?? refreshToken;
    const refreshParams: Record<string, string> = {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: effectiveRefreshToken,
    };
    if (clientSecret) {
      refreshParams['client_secret'] = clientSecret;
    }
    const body = new URLSearchParams(refreshParams);

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      await deleteTokensInternal(tokenPath);
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
      refresh_token: typeof newRefreshToken === 'string' ? newRefreshToken : effectiveRefreshToken,
      expires_at: expiresAt,
      account_id: current?.account_id,
      scope: current?.scope,
    };

    await writeTokensInternal(updated, tokenPath);
    return accessToken;
  });
}

async function readTokensInternal(tokenPath: string): Promise<StoredTokens | null> {
  const record = await readTokenRecord(tokenPath);
  if (!record) {
    return null;
  }

  const metadata = extractMetadata(record);
  if (!metadata) {
    return null;
  }

  const configuredMode = resolveTokenStoreMode(process.env['KEYGATE_TOKEN_STORE']);
  const disableKeychain = isTruthyEnvValue(process.env['KEYGATE_DISABLE_KEYCHAIN']);
  const persistedMode = normalizeStorageMode(record.storage_mode);
  const preferredMode = resolvePreferredMode(configuredMode, persistedMode);
  let resolved = await resolveSecretStore({
    tokenFilePath: tokenPath,
    mode: preferredMode,
    disableKeychain,
  });

  const legacySecrets = persistedMode === null ? extractSecretsFromRecord(record) : null;

  if (legacySecrets && resolved.backend === 'keychain') {
    try {
      await resolved.store.write(legacySecrets);
      await writeTokenRecord(tokenPath, buildMetadataRecord(metadata, 'keychain'));
      return toStoredTokens(metadata, legacySecrets, 'keychain');
    } catch (error) {
      if (configuredMode !== 'auto') {
        throw error;
      }

      resolved = await resolveSecretStore({
        tokenFilePath: tokenPath,
        mode: 'file',
        disableKeychain: true,
      });
      await writeTokenRecord(tokenPath, buildMetadataRecord(metadata, resolved.backend));
      await resolved.store.write(legacySecrets);
      return toStoredTokens(metadata, legacySecrets, resolved.backend);
    }
  }

  if (legacySecrets && resolved.backend === 'file') {
    const shouldNormalizeLegacyRecord =
      record.version !== TOKEN_STORE_VERSION || record.storage_mode !== 'file';
    if (shouldNormalizeLegacyRecord) {
      await writeTokenRecord(tokenPath, buildMetadataRecord(metadata, 'file'));
      await resolved.store.write(legacySecrets);
    }
    return toStoredTokens(metadata, legacySecrets, 'file');
  }

  let secrets: StoredTokenSecrets | null = null;
  try {
    secrets = await resolved.store.read();
  } catch (error) {
    if (!(configuredMode === 'auto' && resolved.backend === 'keychain')) {
      throw error;
    }
    resolved = await resolveSecretStore({
      tokenFilePath: tokenPath,
      mode: 'file',
      disableKeychain: true,
    });
    secrets = await resolved.store.read();
  }

  if (!secrets) {
    return null;
  }

  const hasLegacySecretFields =
    typeof record.access_token === 'string'
    || typeof record.refresh_token === 'string';
  const shouldNormalizeRecord =
    record.version !== TOKEN_STORE_VERSION
    || persistedMode !== resolved.backend
    || (resolved.backend === 'keychain' && hasLegacySecretFields);

  if (shouldNormalizeRecord) {
    await writeTokenRecord(tokenPath, buildMetadataRecord(metadata, resolved.backend));
    if (resolved.backend === 'file') {
      await resolved.store.write(secrets);
    }
  }

  return toStoredTokens(metadata, secrets, resolved.backend);
}

async function writeTokensInternal(tokens: StoredTokens, tokenPath: string): Promise<void> {
  const existing = await readTokenRecord(tokenPath);
  const configuredMode = resolveTokenStoreMode(process.env['KEYGATE_TOKEN_STORE']);
  const disableKeychain = isTruthyEnvValue(process.env['KEYGATE_DISABLE_KEYCHAIN']);
  const preferredMode = resolvePreferredMode(configuredMode, normalizeStorageMode(existing?.storage_mode));

  let resolved = await resolveSecretStore({
    tokenFilePath: tokenPath,
    mode: preferredMode,
    disableKeychain,
  });
  const secrets: StoredTokenSecrets = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  };

  if (resolved.backend === 'keychain') {
    try {
      await resolved.store.write(secrets);
      await writeTokenRecord(tokenPath, buildMetadataRecord(tokens, resolved.backend));
      return;
    } catch (error) {
      if (configuredMode !== 'auto') {
        throw error;
      }
      resolved = await resolveSecretStore({
        tokenFilePath: tokenPath,
        mode: 'file',
        disableKeychain: true,
      });
    }
  }

  await writeTokenRecord(tokenPath, buildMetadataRecord(tokens, resolved.backend));
  await resolved.store.write(secrets);
}

async function deleteTokensInternal(tokenPath: string): Promise<void> {
  const existing = await readTokenRecord(tokenPath);
  const configuredMode = resolveTokenStoreMode(process.env['KEYGATE_TOKEN_STORE']);
  const disableKeychain = isTruthyEnvValue(process.env['KEYGATE_DISABLE_KEYCHAIN']);
  const preferredMode = resolvePreferredMode(configuredMode, normalizeStorageMode(existing?.storage_mode));

  try {
    const resolved = await resolveSecretStore({
      tokenFilePath: tokenPath,
      mode: preferredMode,
      disableKeychain,
    });
    await resolved.store.clear();
  } catch {
    // Best-effort; remove local metadata even when secure storage is unavailable.
  }

  try {
    await fs.unlink(tokenPath);
  } catch {
    // Already deleted or never existed.
  }
}

function resolveTokenStoreLocation(location?: TokenStoreLocation | string): TokenStoreLocation & { namespace: string } {
  if (typeof location === 'string') {
    return { namespace: location };
  }

  if (location?.tokenFilePath) {
    return {
      namespace: location.namespace ?? DEFAULT_TOKEN_NAMESPACE,
      tokenFilePath: path.resolve(location.tokenFilePath),
    };
  }

  return {
    namespace: location?.namespace ?? DEFAULT_TOKEN_NAMESPACE,
  };
}

function sanitizeNamespace(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return normalized.length > 0 ? normalized : DEFAULT_TOKEN_NAMESPACE;
}

function resolvePreferredMode(
  configuredMode: ReturnType<typeof resolveTokenStoreMode>,
  persistedMode: SecretStoreBackend | null
): ReturnType<typeof resolveTokenStoreMode> {
  if (configuredMode !== 'auto') {
    return configuredMode;
  }

  if (persistedMode === 'file' || persistedMode === 'keychain') {
    return persistedMode;
  }

  return 'auto';
}

function normalizeStorageMode(value: unknown): SecretStoreBackend | null {
  if (value === 'file' || value === 'keychain') {
    return value;
  }
  return null;
}

function extractMetadata(record: TokenFileRecord): TokenMetadata | null {
  if (typeof record.expires_at !== 'number' || !Number.isFinite(record.expires_at)) {
    return null;
  }

  return {
    expires_at: record.expires_at,
    account_id: typeof record.account_id === 'string' ? record.account_id : undefined,
    scope: typeof record.scope === 'string' ? record.scope : undefined,
  };
}

function extractSecretsFromRecord(record: TokenFileRecord): StoredTokenSecrets | null {
  if (typeof record.access_token !== 'string' || record.access_token.length === 0) {
    return null;
  }

  return {
    access_token: record.access_token,
    refresh_token: typeof record.refresh_token === 'string' ? record.refresh_token : undefined,
  };
}

function buildMetadataRecord(
  metadata: TokenMetadata,
  backend: SecretStoreBackend
): TokenFileRecord {
  return {
    version: TOKEN_STORE_VERSION,
    storage_mode: backend,
    expires_at: metadata.expires_at,
    account_id: metadata.account_id,
    scope: metadata.scope,
  };
}

function toStoredTokens(
  metadata: TokenMetadata,
  secrets: StoredTokenSecrets,
  storageMode: SecretStoreBackend
): StoredTokens {
  return {
    access_token: secrets.access_token,
    refresh_token: secrets.refresh_token,
    expires_at: metadata.expires_at,
    account_id: metadata.account_id,
    scope: metadata.scope,
    storage_mode: storageMode,
  };
}

async function readTokenRecord(tokenPath: string): Promise<TokenFileRecord | null> {
  try {
    const raw = await fs.readFile(tokenPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed as TokenFileRecord;
  } catch {
    return null;
  }
}

async function writeTokenRecord(tokenPath: string, record: TokenFileRecord): Promise<void> {
  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  const data = JSON.stringify(record, null, 2);
  await fs.writeFile(tokenPath, data, { encoding: 'utf8', mode: 0o600 });
}
