import { randomInt } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { getConfigDir } from '../config/env.js';
import type { DmPolicy } from '../types.js';

export type PairingChannel = 'discord' | 'slack';

interface PendingPairing {
  channel: PairingChannel;
  userId: string;
  code: string;
  createdAt: string;
  expiresAt: string;
}

interface PairingStore {
  version: 1;
  allowlist: Record<PairingChannel, string[]>;
  pending: PendingPairing[];
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function getStorePath(): string {
  return path.join(getConfigDir(), 'pairing.json');
}

function createDefaultStore(): PairingStore {
  return {
    version: 1,
    allowlist: {
      discord: [],
      slack: [],
    },
    pending: [],
  };
}

async function loadStore(): Promise<PairingStore> {
  const storePath = getStorePath();
  try {
    const raw = await fs.readFile(storePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PairingStore>;
    return {
      version: 1,
      allowlist: {
        discord: Array.isArray(parsed?.allowlist?.discord) ? parsed.allowlist.discord.filter((v) => typeof v === 'string') : [],
        slack: Array.isArray(parsed?.allowlist?.slack) ? parsed.allowlist.slack.filter((v) => typeof v === 'string') : [],
      },
      pending: Array.isArray(parsed?.pending)
        ? parsed.pending.filter((entry): entry is PendingPairing =>
          Boolean(entry)
          && (entry as PendingPairing).channel !== undefined
          && ((entry as PendingPairing).channel === 'discord' || (entry as PendingPairing).channel === 'slack')
          && typeof (entry as PendingPairing).userId === 'string'
          && typeof (entry as PendingPairing).code === 'string'
          && typeof (entry as PendingPairing).createdAt === 'string'
          && typeof (entry as PendingPairing).expiresAt === 'string'
        )
        : [],
    };
  } catch {
    return createDefaultStore();
  }
}

async function saveStore(store: PairingStore): Promise<void> {
  const storePath = getStorePath();
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function nowMs(): number {
  return Date.now();
}

function isExpired(entry: PendingPairing, now = nowMs()): boolean {
  return Number.isFinite(Date.parse(entry.expiresAt)) && Date.parse(entry.expiresAt) <= now;
}

function compactStore(store: PairingStore): PairingStore {
  const now = nowMs();
  store.pending = store.pending.filter((entry) => !isExpired(entry, now));
  store.allowlist.discord = Array.from(new Set(store.allowlist.discord.map((id) => id.trim()).filter((id) => id.length > 0)));
  store.allowlist.slack = Array.from(new Set(store.allowlist.slack.map((id) => id.trim()).filter((id) => id.length > 0)));
  return store;
}

function generateCode(length = 6): string {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

export async function isUserPaired(channel: PairingChannel, userId: string): Promise<boolean> {
  const normalizedUser = userId.trim();
  if (!normalizedUser) {
    return false;
  }

  const store = compactStore(await loadStore());
  return store.allowlist[channel].includes(normalizedUser);
}

export async function createOrGetPairingCode(
  channel: PairingChannel,
  userId: string,
  ttlMs = DEFAULT_TTL_MS,
): Promise<{ code: string; expiresAt: string; created: boolean }> {
  const normalizedUser = userId.trim();
  if (!normalizedUser) {
    throw new Error('userId is required');
  }

  const store = compactStore(await loadStore());
  const existing = store.pending.find((entry) => entry.channel === channel && entry.userId === normalizedUser);
  if (existing && !isExpired(existing)) {
    await saveStore(store);
    return { code: existing.code, expiresAt: existing.expiresAt, created: false };
  }

  const createdAt = new Date().toISOString();
  const expiresAt = new Date(nowMs() + Math.max(30_000, ttlMs)).toISOString();

  let code = generateCode();
  const existingCodes = new Set(store.pending.map((entry) => entry.code));
  while (existingCodes.has(code)) {
    code = generateCode();
  }

  store.pending.push({ channel, userId: normalizedUser, code, createdAt, expiresAt });
  await saveStore(store);
  return { code, expiresAt, created: true };
}

export async function approvePairingCode(
  channel: PairingChannel,
  code: string,
): Promise<{ approved: boolean; userId?: string; reason?: string }> {
  const normalizedCode = code.trim().toUpperCase();
  if (!normalizedCode) {
    return { approved: false, reason: 'code_missing' };
  }

  const store = compactStore(await loadStore());
  const match = store.pending.find((entry) => entry.channel === channel && entry.code === normalizedCode);
  if (!match) {
    await saveStore(store);
    return { approved: false, reason: 'code_not_found' };
  }

  store.pending = store.pending.filter((entry) => !(entry.channel === channel && entry.code === normalizedCode));
  if (!store.allowlist[channel].includes(match.userId)) {
    store.allowlist[channel].push(match.userId);
  }

  await saveStore(compactStore(store));
  return { approved: true, userId: match.userId };
}

export async function listPendingPairings(channel?: PairingChannel): Promise<PendingPairing[]> {
  const store = compactStore(await loadStore());
  await saveStore(store);
  return channel ? store.pending.filter((entry) => entry.channel === channel) : store.pending;
}

export function isDmAllowedByPolicy(options: {
  policy: DmPolicy;
  userId: string;
  allowFrom: string[];
  paired: boolean;
}): boolean {
  const userId = options.userId.trim();
  const allowFrom = options.allowFrom;

  if (allowFrom.includes('*') || allowFrom.includes(userId)) {
    return true;
  }

  if (options.policy === 'open') {
    return true;
  }

  if (options.policy === 'pairing') {
    return options.paired;
  }

  return false;
}
