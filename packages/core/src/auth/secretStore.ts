import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const KEYCHAIN_SERVICE_PREFIX = 'dev.keygate.openai.oauth';
const KEYCHAIN_ACCESS_ACCOUNT = 'access_token';
const KEYCHAIN_REFRESH_ACCOUNT = 'refresh_token';

export type TokenStoreMode = 'auto' | 'keychain' | 'file';
export type SecretStoreBackend = 'keychain' | 'file';

export interface StoredTokenSecrets {
  access_token: string;
  refresh_token?: string;
}

export interface SecretStore {
  readonly backend: SecretStoreBackend;
  read(): Promise<StoredTokenSecrets | null>;
  write(secrets: StoredTokenSecrets): Promise<void>;
  clear(): Promise<void>;
}

interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

interface ResolveSecretStoreOptions {
  tokenFilePath: string;
  mode: TokenStoreMode;
  disableKeychain: boolean;
}

interface ResolvedSecretStore {
  store: SecretStore;
  backend: SecretStoreBackend;
}

let keytarLoaderOverride: (() => Promise<KeytarLike | null>) | null = null;
const keychainHealthCache = new Map<string, Promise<boolean>>();

export async function resolveSecretStore(options: ResolveSecretStoreOptions): Promise<ResolvedSecretStore> {
  const fileStore = new FileSecretStore(options.tokenFilePath);
  if (options.mode === 'file' || options.disableKeychain) {
    return { store: fileStore, backend: 'file' };
  }

  const keychainStore = await createKeychainSecretStore(options.tokenFilePath);
  if (!keychainStore) {
    if (options.mode === 'keychain' && !options.disableKeychain) {
      throw new Error('KEYGATE_TOKEN_STORE=keychain is set, but keychain storage is unavailable.');
    }

    return { store: fileStore, backend: 'file' };
  }

  return { store: keychainStore, backend: 'keychain' };
}

export function resolveTokenStoreMode(value: string | undefined): TokenStoreMode {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case 'file':
      return 'file';
    case 'keychain':
      return 'keychain';
    case 'auto':
    case '':
    case undefined:
      return 'auto';
    default:
      return 'auto';
  }
}

export function isTruthyEnvValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function __setKeytarLoaderForTests(loader: (() => Promise<KeytarLike | null>) | null): void {
  keytarLoaderOverride = loader;
  keychainHealthCache.clear();
}

class FileSecretStore implements SecretStore {
  readonly backend: SecretStoreBackend = 'file';

  constructor(private readonly tokenFilePath: string) {}

  async read(): Promise<StoredTokenSecrets | null> {
    const record = await readSecretRecord(this.tokenFilePath);
    if (!record) {
      return null;
    }

    const accessToken = record['access_token'];
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      return null;
    }

    const refreshToken = record['refresh_token'];
    return {
      access_token: accessToken,
      refresh_token: typeof refreshToken === 'string' ? refreshToken : undefined,
    };
  }

  async write(secrets: StoredTokenSecrets): Promise<void> {
    const record = await readSecretRecord(this.tokenFilePath) ?? {};
    record['access_token'] = secrets.access_token;
    if (typeof secrets.refresh_token === 'string' && secrets.refresh_token.length > 0) {
      record['refresh_token'] = secrets.refresh_token;
    } else {
      delete record['refresh_token'];
    }

    await writeSecretRecord(this.tokenFilePath, record);
  }

  async clear(): Promise<void> {
    const record = await readSecretRecord(this.tokenFilePath);
    if (!record) {
      return;
    }

    delete record['access_token'];
    delete record['refresh_token'];

    if (Object.keys(record).length === 0) {
      try {
        await fs.unlink(this.tokenFilePath);
      } catch {
        // Already deleted.
      }
      return;
    }

    await writeSecretRecord(this.tokenFilePath, record);
  }
}

class KeychainSecretStore implements SecretStore {
  readonly backend: SecretStoreBackend = 'keychain';

  constructor(
    private readonly keytar: KeytarLike,
    private readonly service: string
  ) {}

  async read(): Promise<StoredTokenSecrets | null> {
    const accessToken = await this.keytar.getPassword(this.service, KEYCHAIN_ACCESS_ACCOUNT);
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      return null;
    }

    const refreshToken = await this.keytar.getPassword(this.service, KEYCHAIN_REFRESH_ACCOUNT);
    return {
      access_token: accessToken,
      refresh_token: typeof refreshToken === 'string' ? refreshToken : undefined,
    };
  }

  async write(secrets: StoredTokenSecrets): Promise<void> {
    await this.keytar.setPassword(this.service, KEYCHAIN_ACCESS_ACCOUNT, secrets.access_token);
    if (typeof secrets.refresh_token === 'string' && secrets.refresh_token.length > 0) {
      await this.keytar.setPassword(this.service, KEYCHAIN_REFRESH_ACCOUNT, secrets.refresh_token);
    } else {
      await this.keytar.deletePassword(this.service, KEYCHAIN_REFRESH_ACCOUNT);
    }
  }

  async clear(): Promise<void> {
    await this.keytar.deletePassword(this.service, KEYCHAIN_ACCESS_ACCOUNT);
    await this.keytar.deletePassword(this.service, KEYCHAIN_REFRESH_ACCOUNT);
  }
}

async function createKeychainSecretStore(tokenFilePath: string): Promise<KeychainSecretStore | null> {
  const keytar = await loadKeytar();
  if (!keytar) {
    return null;
  }

  const service = buildKeychainServiceName(tokenFilePath);
  const isHealthy = await checkKeychainHealth(keytar, service);
  if (!isHealthy) {
    return null;
  }

  return new KeychainSecretStore(keytar, service);
}

function buildKeychainServiceName(tokenFilePath: string): string {
  const digest = createHash('sha256')
    .update(path.resolve(tokenFilePath))
    .digest('hex')
    .slice(0, 16);
  return `${KEYCHAIN_SERVICE_PREFIX}.${digest}`;
}

async function loadKeytar(): Promise<KeytarLike | null> {
  if (keytarLoaderOverride) {
    return keytarLoaderOverride();
  }

  const moduleName = 'keytar';
  try {
    const loaded = await import(moduleName);
    const candidate = (loaded as { default?: unknown }).default ?? loaded;
    if (isKeytarLike(candidate)) {
      return candidate;
    }
  } catch {
    return null;
  }

  return null;
}

function isKeytarLike(value: unknown): value is KeytarLike {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<KeytarLike>;
  return typeof candidate.getPassword === 'function'
    && typeof candidate.setPassword === 'function'
    && typeof candidate.deletePassword === 'function';
}

async function checkKeychainHealth(keytar: KeytarLike, service: string): Promise<boolean> {
  const cached = keychainHealthCache.get(service);
  if (cached) {
    return cached;
  }

  const probe = runKeychainHealthCheck(keytar, service);
  keychainHealthCache.set(service, probe);
  return probe;
}

async function runKeychainHealthCheck(keytar: KeytarLike, service: string): Promise<boolean> {
  const probeAccount = `probe-${randomUUID()}`;
  const probeSecret = `probe-${Date.now()}`;

  try {
    await keytar.setPassword(service, probeAccount, probeSecret);
    const loaded = await keytar.getPassword(service, probeAccount);
    await keytar.deletePassword(service, probeAccount);
    return loaded === probeSecret;
  } catch {
    try {
      await keytar.deletePassword(service, probeAccount);
    } catch {
      // Ignore cleanup errors.
    }
    return false;
  }
}

async function readSecretRecord(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function writeSecretRecord(filePath: string, record: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = JSON.stringify(record, null, 2);
  await fs.writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 });
}
