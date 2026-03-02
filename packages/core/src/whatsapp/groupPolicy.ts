import { isDmAllowedByPolicy } from '../security/pairing.js';
import type { WhatsAppConfig, WhatsAppGroupRule } from '../types.js';
import { normalizeWhatsAppGroupKey } from './normalize.js';

export interface WhatsAppGroupPolicyResult {
  allowed: boolean;
  reason: 'allowed' | 'group_closed' | 'group_not_selected' | 'mention_required';
  groupKey: string;
  requireMention: boolean;
  rule?: WhatsAppGroupRule;
}

export function isWhatsAppDmAllowed(options: {
  config: WhatsAppConfig;
  userId: string;
  paired: boolean;
}): boolean {
  return isDmAllowedByPolicy({
    policy: options.config.dmPolicy,
    userId: options.userId,
    allowFrom: options.config.allowFrom,
    paired: options.paired,
  });
}

export function evaluateWhatsAppGroupPolicy(options: {
  config: WhatsAppConfig;
  groupIdOrKey: string;
  mentionedSelf: boolean;
  repliedToRecentBotMessage: boolean;
}): WhatsAppGroupPolicyResult {
  const groupKey = normalizeWhatsAppGroupKey(options.groupIdOrKey);
  if (!groupKey) {
    return {
      allowed: false,
      reason: 'group_closed',
      groupKey: 'group:unknown',
      requireMention: true,
    };
  }

  if (options.config.groupMode === 'closed') {
    return {
      allowed: false,
      reason: 'group_closed',
      groupKey,
      requireMention: true,
    };
  }

  const rule = options.config.groups[groupKey];
  if (options.config.groupMode === 'selected' && !rule) {
    return {
      allowed: false,
      reason: 'group_not_selected',
      groupKey,
      requireMention: true,
    };
  }

  const requireMention = typeof rule?.requireMention === 'boolean'
    ? rule.requireMention
    : options.config.groupRequireMentionDefault;

  const mentioned = options.mentionedSelf || options.repliedToRecentBotMessage;
  if (requireMention && !mentioned) {
    return {
      allowed: false,
      reason: 'mention_required',
      groupKey,
      requireMention,
      rule,
    };
  }

  return {
    allowed: true,
    reason: 'allowed',
    groupKey,
    requireMention,
    rule,
  };
}
