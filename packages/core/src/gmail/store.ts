import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getConfigDir } from '../config/env.js';

export interface GmailAccountRecord {
  id: string;
  email: string;
  tokenFilePath: string;
  createdAt: string;
  updatedAt: string;
  lastHistoryId?: string;
  lastValidatedAt?: string;
  lastError?: string;
}

export interface GmailWatchRecord {
  id: string;
  accountId: string;
  targetSessionId: string;
  labelIds: string[];
  promptPrefix: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastHistoryId?: string;
  expirationAt?: string;
  lastRenewedAt?: string;
  lastProcessedAt?: string;
  lastError?: string;
}

export interface GmailWatchCreateInput {
  accountId: string;
  targetSessionId: string;
  labelIds?: string[];
  promptPrefix?: string;
  enabled?: boolean;
}

export interface GmailWatchUpdateInput {
  targetSessionId?: string;
  labelIds?: string[];
  promptPrefix?: string;
  enabled?: boolean;
  lastHistoryId?: string | null;
  expirationAt?: string | null;
  lastRenewedAt?: string | null;
  lastProcessedAt?: string | null;
  lastError?: string | null;
}

interface GmailDedupRecord {
  key: string;
  receivedAt: string;
}

interface GmailStorePayload {
  version: 1;
  accounts: GmailAccountRecord[];
  watches: GmailWatchRecord[];
  dedupe: GmailDedupRecord[];
}

const STORE_VERSION = 1;
const MAX_PROMPT_PREFIX_CHARS = 240;
const MAX_TARGET_SESSION_ID_CHARS = 256;
const MAX_DEDUPE_RECORDS = 2_000;
const DEDUPE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function storePath(): string {
  return path.join(getConfigDir(), 'gmail-store.json');
}

function defaultPayload(): GmailStorePayload {
  return {
    version: STORE_VERSION,
    accounts: [],
    watches: [],
    dedupe: [],
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeLabelIds(values: string[] | undefined): string[] {
  return Array.from(new Set(
    (values ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  ));
}

function compactPayload(payload: GmailStorePayload): GmailStorePayload {
  const cutoff = Date.now() - DEDUPE_RETENTION_MS;
  payload.dedupe = payload.dedupe
    .filter((entry) => Date.parse(entry.receivedAt) >= cutoff)
    .slice(-MAX_DEDUPE_RECORDS);
  return payload;
}

async function loadPayload(): Promise<GmailStorePayload> {
  try {
    const raw = await fs.readFile(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<GmailStorePayload>;
    const payload: GmailStorePayload = {
      version: STORE_VERSION,
      accounts: Array.isArray(parsed.accounts)
        ? parsed.accounts.filter((entry): entry is GmailAccountRecord => typeof entry?.id === 'string')
        : [],
      watches: Array.isArray(parsed.watches)
        ? parsed.watches.filter((entry): entry is GmailWatchRecord => typeof entry?.id === 'string')
        : [],
      dedupe: Array.isArray(parsed.dedupe)
        ? parsed.dedupe.filter((entry): entry is GmailDedupRecord => typeof entry?.key === 'string')
        : [],
    };
    return compactPayload(payload);
  } catch {
    return defaultPayload();
  }
}

async function savePayload(payload: GmailStorePayload): Promise<void> {
  const target = storePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(compactPayload(payload), null, 2)}\n`, 'utf8');
  await fs.rename(temp, target);
}

export class GmailStore {
  async listAccounts(): Promise<GmailAccountRecord[]> {
    const payload = await loadPayload();
    return payload.accounts
      .map((entry) => ({ ...entry }))
      .sort((left, right) => left.email.localeCompare(right.email));
  }

  async getAccount(accountId: string): Promise<GmailAccountRecord | null> {
    const payload = await loadPayload();
    const account = payload.accounts.find((entry) => entry.id === accountId.trim());
    return account ? { ...account } : null;
  }

  async findAccountByEmail(email: string): Promise<GmailAccountRecord | null> {
    const normalized = normalizeEmail(email);
    const payload = await loadPayload();
    const account = payload.accounts.find((entry) => normalizeEmail(entry.email) === normalized);
    return account ? { ...account } : null;
  }

  async upsertAccount(input: {
    id: string;
    email: string;
    tokenFilePath: string;
    lastHistoryId?: string;
    lastValidatedAt?: string;
    lastError?: string | null;
  }): Promise<GmailAccountRecord> {
    const payload = await loadPayload();
    const accountId = input.id.trim();
    const email = normalizeEmail(input.email);
    if (!accountId || !email) {
      throw new Error('account id and email are required');
    }

    const now = nowIso();
    const existing = payload.accounts.find((entry) => entry.id === accountId);
    if (existing) {
      existing.email = email;
      existing.tokenFilePath = input.tokenFilePath;
      existing.updatedAt = now;
      if (typeof input.lastHistoryId === 'string' && input.lastHistoryId.trim()) {
        existing.lastHistoryId = input.lastHistoryId.trim();
      }
      if (typeof input.lastValidatedAt === 'string' && input.lastValidatedAt.trim()) {
        existing.lastValidatedAt = input.lastValidatedAt.trim();
      }
      if (input.lastError === null) {
        delete existing.lastError;
      } else if (typeof input.lastError === 'string' && input.lastError.trim()) {
        existing.lastError = input.lastError.trim();
      }
      await savePayload(payload);
      return { ...existing };
    }

    const account: GmailAccountRecord = {
      id: accountId,
      email,
      tokenFilePath: input.tokenFilePath,
      createdAt: now,
      updatedAt: now,
      lastHistoryId: input.lastHistoryId?.trim() || undefined,
      lastValidatedAt: input.lastValidatedAt?.trim() || undefined,
      lastError: input.lastError?.trim() || undefined,
    };
    payload.accounts.push(account);
    await savePayload(payload);
    return { ...account };
  }

  async updateAccount(
    accountId: string,
    patch: {
      lastHistoryId?: string | null;
      lastValidatedAt?: string | null;
      lastError?: string | null;
    }
  ): Promise<GmailAccountRecord> {
    const payload = await loadPayload();
    const account = payload.accounts.find((entry) => entry.id === accountId.trim());
    if (!account) {
      throw new Error(`Gmail account not found: ${accountId}`);
    }

    if (patch.lastHistoryId === null) {
      delete account.lastHistoryId;
    } else if (typeof patch.lastHistoryId === 'string' && patch.lastHistoryId.trim()) {
      account.lastHistoryId = patch.lastHistoryId.trim();
    }

    if (patch.lastValidatedAt === null) {
      delete account.lastValidatedAt;
    } else if (typeof patch.lastValidatedAt === 'string' && patch.lastValidatedAt.trim()) {
      account.lastValidatedAt = patch.lastValidatedAt.trim();
    }

    if (patch.lastError === null) {
      delete account.lastError;
    } else if (typeof patch.lastError === 'string' && patch.lastError.trim()) {
      account.lastError = patch.lastError.trim();
    }

    account.updatedAt = nowIso();
    await savePayload(payload);
    return { ...account };
  }

  async listWatches(): Promise<GmailWatchRecord[]> {
    const payload = await loadPayload();
    return payload.watches
      .map((entry) => ({ ...entry, labelIds: [...entry.labelIds] }))
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }

  async getWatch(watchId: string): Promise<GmailWatchRecord | null> {
    const payload = await loadPayload();
    const watch = payload.watches.find((entry) => entry.id === watchId.trim());
    return watch ? { ...watch, labelIds: [...watch.labelIds] } : null;
  }

  async listWatchesForAccount(accountId: string): Promise<GmailWatchRecord[]> {
    const payload = await loadPayload();
    return payload.watches
      .filter((entry) => entry.accountId === accountId.trim())
      .map((entry) => ({ ...entry, labelIds: [...entry.labelIds] }));
  }

  async createWatch(input: GmailWatchCreateInput): Promise<GmailWatchRecord> {
    const targetSessionId = input.targetSessionId.trim();
    if (!input.accountId.trim() || !targetSessionId) {
      throw new Error('accountId and targetSessionId are required');
    }
    if (targetSessionId.length > MAX_TARGET_SESSION_ID_CHARS) {
      throw new Error(`targetSessionId exceeds ${MAX_TARGET_SESSION_ID_CHARS} characters`);
    }

    const promptPrefix = (input.promptPrefix?.trim() || '[GMAIL WATCH EVENT]');
    if (promptPrefix.length > MAX_PROMPT_PREFIX_CHARS) {
      throw new Error(`promptPrefix exceeds ${MAX_PROMPT_PREFIX_CHARS} characters`);
    }

    const now = nowIso();
    const watch: GmailWatchRecord = {
      id: randomUUID(),
      accountId: input.accountId.trim(),
      targetSessionId,
      labelIds: normalizeLabelIds(input.labelIds),
      promptPrefix,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };

    const payload = await loadPayload();
    payload.watches.push(watch);
    await savePayload(payload);
    return { ...watch, labelIds: [...watch.labelIds] };
  }

  async updateWatch(watchId: string, patch: GmailWatchUpdateInput): Promise<GmailWatchRecord> {
    const payload = await loadPayload();
    const watch = payload.watches.find((entry) => entry.id === watchId.trim());
    if (!watch) {
      throw new Error(`Gmail watch not found: ${watchId}`);
    }

    if (typeof patch.targetSessionId === 'string') {
      const targetSessionId = patch.targetSessionId.trim();
      if (!targetSessionId) {
        throw new Error('targetSessionId cannot be empty');
      }
      if (targetSessionId.length > MAX_TARGET_SESSION_ID_CHARS) {
        throw new Error(`targetSessionId exceeds ${MAX_TARGET_SESSION_ID_CHARS} characters`);
      }
      watch.targetSessionId = targetSessionId;
    }

    if (Array.isArray(patch.labelIds)) {
      watch.labelIds = normalizeLabelIds(patch.labelIds);
    }

    if (typeof patch.promptPrefix === 'string') {
      const promptPrefix = patch.promptPrefix.trim();
      if (!promptPrefix) {
        throw new Error('promptPrefix cannot be empty');
      }
      if (promptPrefix.length > MAX_PROMPT_PREFIX_CHARS) {
        throw new Error(`promptPrefix exceeds ${MAX_PROMPT_PREFIX_CHARS} characters`);
      }
      watch.promptPrefix = promptPrefix;
    }

    if (typeof patch.enabled === 'boolean') {
      watch.enabled = patch.enabled;
    }

    if (patch.lastHistoryId === null) {
      delete watch.lastHistoryId;
    } else if (typeof patch.lastHistoryId === 'string' && patch.lastHistoryId.trim()) {
      watch.lastHistoryId = patch.lastHistoryId.trim();
    }

    if (patch.expirationAt === null) {
      delete watch.expirationAt;
    } else if (typeof patch.expirationAt === 'string' && patch.expirationAt.trim()) {
      watch.expirationAt = patch.expirationAt.trim();
    }

    if (patch.lastRenewedAt === null) {
      delete watch.lastRenewedAt;
    } else if (typeof patch.lastRenewedAt === 'string' && patch.lastRenewedAt.trim()) {
      watch.lastRenewedAt = patch.lastRenewedAt.trim();
    }

    if (patch.lastProcessedAt === null) {
      delete watch.lastProcessedAt;
    } else if (typeof patch.lastProcessedAt === 'string' && patch.lastProcessedAt.trim()) {
      watch.lastProcessedAt = patch.lastProcessedAt.trim();
    }

    if (patch.lastError === null) {
      delete watch.lastError;
    } else if (typeof patch.lastError === 'string' && patch.lastError.trim()) {
      watch.lastError = patch.lastError.trim();
    }

    watch.updatedAt = nowIso();
    await savePayload(payload);
    return { ...watch, labelIds: [...watch.labelIds] };
  }

  async deleteWatch(watchId: string): Promise<boolean> {
    const payload = await loadPayload();
    const before = payload.watches.length;
    payload.watches = payload.watches.filter((entry) => entry.id !== watchId.trim());
    const changed = before !== payload.watches.length;
    if (changed) {
      await savePayload(payload);
    }
    return changed;
  }

  async recordNotification(key: string): Promise<boolean> {
    const normalized = key.trim();
    if (!normalized) {
      return false;
    }

    const payload = await loadPayload();
    if (payload.dedupe.some((entry) => entry.key === normalized)) {
      return false;
    }

    payload.dedupe.push({
      key: normalized,
      receivedAt: nowIso(),
    });
    await savePayload(payload);
    return true;
  }
}
