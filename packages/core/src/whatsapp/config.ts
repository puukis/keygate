import type { KeygateConfig, WhatsAppConfig } from '../types.js';
import { loadPersistedWhatsAppConfig, savePersistedConfigObject } from '../config/env.js';
import {
  getWhatsAppAuthDir,
  hasWhatsAppLinkedAuth,
  hasWhatsAppLinkedAuthSync,
  readWhatsAppLinkedAccountMeta,
  readWhatsAppLinkedAccountMetaSync,
} from './auth.js';

export interface WhatsAppConfigView {
  linked: boolean;
  linkedPhone: string | null;
  authDir: string;
  dmPolicy: WhatsAppConfig['dmPolicy'];
  allowFrom: string[];
  groupMode: WhatsAppConfig['groupMode'];
  groups: WhatsAppConfig['groups'];
  groupRequireMentionDefault: boolean;
  sendReadReceipts: boolean;
}

export function getDefaultWhatsAppConfig(): WhatsAppConfig {
  return loadPersistedWhatsAppConfig({});
}

export function normalizeWhatsAppConfig(config: Partial<WhatsAppConfig> | undefined): WhatsAppConfig {
  const defaults = getDefaultWhatsAppConfig();
  const source = config ?? {};

  return {
    dmPolicy: source.dmPolicy ?? defaults.dmPolicy,
    allowFrom: Array.isArray(source.allowFrom)
      ? Array.from(new Set(source.allowFrom.map((entry) => entry.trim()).filter((entry) => entry.length > 0)))
      : defaults.allowFrom,
    groupMode: source.groupMode ?? defaults.groupMode,
    groups: source.groups ? Object.fromEntries(Object.entries(source.groups).map(([key, value]) => [key, { ...value }])) : {},
    groupRequireMentionDefault:
      typeof source.groupRequireMentionDefault === 'boolean'
        ? source.groupRequireMentionDefault
        : defaults.groupRequireMentionDefault,
    sendReadReceipts:
      typeof source.sendReadReceipts === 'boolean'
        ? source.sendReadReceipts
        : defaults.sendReadReceipts,
  };
}

export function getWhatsAppConfig(config: Pick<KeygateConfig, 'whatsapp'> | null | undefined): WhatsAppConfig {
  return normalizeWhatsAppConfig(config?.whatsapp);
}

export async function persistWhatsAppConfig(nextConfig: WhatsAppConfig): Promise<WhatsAppConfig> {
  const normalized = normalizeWhatsAppConfig(nextConfig);
  await savePersistedConfigObject((current) => ({
    ...current,
    whatsapp: {
      dmPolicy: normalized.dmPolicy,
      allowFrom: [...normalized.allowFrom],
      groupMode: normalized.groupMode,
      groups: Object.fromEntries(Object.entries(normalized.groups).map(([key, rule]) => [key, { ...rule }])),
      groupRequireMentionDefault: normalized.groupRequireMentionDefault,
      sendReadReceipts: normalized.sendReadReceipts,
    },
  }));
  return normalized;
}

export async function buildWhatsAppConfigView(config: Pick<KeygateConfig, 'whatsapp'> | null | undefined): Promise<WhatsAppConfigView> {
  const whatsapp = getWhatsAppConfig(config);
  const linked = await hasWhatsAppLinkedAuth();
  const meta = await readWhatsAppLinkedAccountMeta();

  return {
    linked,
    linkedPhone: meta?.phoneNumber ?? null,
    authDir: getWhatsAppAuthDir(),
    dmPolicy: whatsapp.dmPolicy,
    allowFrom: [...whatsapp.allowFrom],
    groupMode: whatsapp.groupMode,
    groups: Object.fromEntries(Object.entries(whatsapp.groups).map(([key, rule]) => [key, { ...rule }])),
    groupRequireMentionDefault: whatsapp.groupRequireMentionDefault,
    sendReadReceipts: whatsapp.sendReadReceipts,
  };
}

export function buildWhatsAppConfigViewSync(config: Pick<KeygateConfig, 'whatsapp'> | null | undefined): WhatsAppConfigView {
  const whatsapp = getWhatsAppConfig(config);
  const linked = hasWhatsAppLinkedAuthSync();
  const meta = readWhatsAppLinkedAccountMetaSync();

  return {
    linked,
    linkedPhone: meta?.phoneNumber ?? null,
    authDir: getWhatsAppAuthDir(),
    dmPolicy: whatsapp.dmPolicy,
    allowFrom: [...whatsapp.allowFrom],
    groupMode: whatsapp.groupMode,
    groups: Object.fromEntries(Object.entries(whatsapp.groups).map(([key, rule]) => [key, { ...rule }])),
    groupRequireMentionDefault: whatsapp.groupRequireMentionDefault,
    sendReadReceipts: whatsapp.sendReadReceipts,
  };
}
