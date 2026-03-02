export function normalizeWhatsAppPhoneNumber(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const withoutSuffix = trimmed.split('@', 1)[0] ?? trimmed;
  const withoutDevice = withoutSuffix.split(':', 1)[0] ?? withoutSuffix;
  const digits = withoutDevice.replace(/\D+/g, '');
  if (!digits) {
    return null;
  }

  return `+${digits}`;
}

export function isWhatsAppGroupJid(jid: string | null | undefined): boolean {
  if (typeof jid !== 'string') {
    return false;
  }

  return jid.trim().endsWith('@g.us');
}

export function extractBareWhatsAppGroupId(jid: string | null | undefined): string | null {
  if (!isWhatsAppGroupJid(jid)) {
    return null;
  }

  const bare = jid!.trim().slice(0, -'@g.us'.length);
  return bare.length > 0 ? bare : null;
}

export function buildWhatsAppDmChatId(phoneNumber: string): string {
  return `dm:${phoneNumber}`;
}

export function buildWhatsAppGroupChatId(groupId: string): string {
  return `group:${groupId}`;
}

export function normalizeWhatsAppChatId(jid: string | null | undefined): string | null {
  const groupId = extractBareWhatsAppGroupId(jid);
  if (groupId) {
    return buildWhatsAppGroupChatId(groupId);
  }

  const phoneNumber = normalizeWhatsAppPhoneNumber(jid);
  if (phoneNumber) {
    return buildWhatsAppDmChatId(phoneNumber);
  }

  return null;
}

export function normalizeWhatsAppUserId(jid: string | null | undefined): string | null {
  return normalizeWhatsAppPhoneNumber(jid);
}

export function normalizeWhatsAppGroupKey(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('group:')) {
    const suffix = trimmed.slice('group:'.length).trim();
    return suffix.length > 0 ? `group:${suffix}` : null;
  }

  if (isWhatsAppGroupJid(trimmed)) {
    const groupId = extractBareWhatsAppGroupId(trimmed);
    return groupId ? `group:${groupId}` : null;
  }

  return null;
}
