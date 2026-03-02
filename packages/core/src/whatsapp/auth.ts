import path from 'node:path';
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { getConfigDir } from '../config/env.js';

export interface WhatsAppLinkedAccountMeta {
  jid?: string;
  phoneNumber?: string | null;
  linkedAt?: string;
  lastSeenAt?: string;
}

export function getWhatsAppChannelDir(): string {
  return path.join(getConfigDir(), 'channels', 'whatsapp');
}

export function getWhatsAppAuthDir(): string {
  return path.join(getWhatsAppChannelDir(), 'auth');
}

export function getWhatsAppAuthCredsPath(): string {
  return path.join(getWhatsAppAuthDir(), 'creds.json');
}

export function getWhatsAppMetaPath(): string {
  return path.join(getWhatsAppChannelDir(), 'meta.json');
}

export async function ensureWhatsAppAuthDir(): Promise<string> {
  const authDir = getWhatsAppAuthDir();
  await fs.mkdir(authDir, { recursive: true });
  return authDir;
}

export async function hasWhatsAppLinkedAuth(): Promise<boolean> {
  try {
    const stat = await fs.stat(getWhatsAppAuthCredsPath());
    return stat.isFile();
  } catch {
    return false;
  }
}

export function hasWhatsAppLinkedAuthSync(): boolean {
  return existsSync(getWhatsAppAuthCredsPath());
}

export async function readWhatsAppLinkedAccountMeta(): Promise<WhatsAppLinkedAccountMeta | null> {
  try {
    const raw = await fs.readFile(getWhatsAppMetaPath(), 'utf8');
    const parsed = JSON.parse(raw) as WhatsAppLinkedAccountMeta;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    return {
      jid: typeof parsed.jid === 'string' ? parsed.jid : undefined,
      phoneNumber: typeof parsed.phoneNumber === 'string' ? parsed.phoneNumber : null,
      linkedAt: typeof parsed.linkedAt === 'string' ? parsed.linkedAt : undefined,
      lastSeenAt: typeof parsed.lastSeenAt === 'string' ? parsed.lastSeenAt : undefined,
    };
  } catch {
    return null;
  }
}

export function readWhatsAppLinkedAccountMetaSync(): WhatsAppLinkedAccountMeta | null {
  try {
    const raw = readFileSync(getWhatsAppMetaPath(), 'utf8');
    const parsed = JSON.parse(raw) as WhatsAppLinkedAccountMeta;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    return {
      jid: typeof parsed.jid === 'string' ? parsed.jid : undefined,
      phoneNumber: typeof parsed.phoneNumber === 'string' ? parsed.phoneNumber : null,
      linkedAt: typeof parsed.linkedAt === 'string' ? parsed.linkedAt : undefined,
      lastSeenAt: typeof parsed.lastSeenAt === 'string' ? parsed.lastSeenAt : undefined,
    };
  } catch {
    return null;
  }
}

export async function writeWhatsAppLinkedAccountMeta(meta: WhatsAppLinkedAccountMeta): Promise<void> {
  const nextMeta: WhatsAppLinkedAccountMeta = {
    ...meta,
    lastSeenAt: new Date().toISOString(),
    linkedAt: meta.linkedAt ?? new Date().toISOString(),
  };

  const metaPath = getWhatsAppMetaPath();
  await fs.mkdir(path.dirname(metaPath), { recursive: true });
  await fs.writeFile(metaPath, `${JSON.stringify(nextMeta, null, 2)}\n`, 'utf8');
}

export async function clearWhatsAppAuthState(): Promise<void> {
  await fs.rm(getWhatsAppAuthDir(), { recursive: true, force: true });
  await fs.rm(getWhatsAppMetaPath(), { force: true });
}
