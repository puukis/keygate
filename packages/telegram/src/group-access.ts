import type { TelegramConfig } from '@puukis/core';

export interface GroupAccessResult {
  allowed: boolean;
  contentAfterMention: string;
}

/**
 * Check whether a group message should be processed.
 * Handles requireMention per-group config and global groupMode.
 */
export function isGroupAllowed(
  config: TelegramConfig,
  chatId: number,
  messageText: string,
  botUsername: string,
): GroupAccessResult {
  if (config.groupMode === 'closed') {
    return { allowed: false, contentAfterMention: messageText };
  }

  if (config.groupMode === 'open') {
    return { allowed: true, contentAfterMention: messageText };
  }

  // 'mention' mode — check per-chat rule then fall back to global default
  const perChatRule = config.groupRules[String(chatId)];
  const requireMention =
    perChatRule?.requireMention !== undefined
      ? perChatRule.requireMention
      : config.requireMentionDefault;

  if (!requireMention) {
    return { allowed: true, contentAfterMention: messageText };
  }

  const mentionPattern = new RegExp(`@${escapeRegex(botUsername)}\\b`, 'i');
  if (!mentionPattern.test(messageText)) {
    return { allowed: false, contentAfterMention: messageText };
  }

  const contentAfterMention = messageText.replace(mentionPattern, '').trim();
  return { allowed: true, contentAfterMention };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
