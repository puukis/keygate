import { describe, expect, it } from 'vitest';
import {
  evaluateWhatsAppGroupPolicy,
  isWhatsAppDmAllowed,
} from '../groupPolicy.js';
import {
  buildWhatsAppDmChatId,
  normalizeWhatsAppChatId,
  normalizeWhatsAppPhoneNumber,
} from '../normalize.js';

describe('whatsapp group policy helpers', () => {
  it('normalizes whatsapp ids into stable chat ids', () => {
    expect(normalizeWhatsAppPhoneNumber('15551234567@s.whatsapp.net')).toBe('+15551234567');
    expect(normalizeWhatsAppChatId('15551234567@s.whatsapp.net')).toBe(buildWhatsAppDmChatId('+15551234567'));
    expect(normalizeWhatsAppChatId('120363025870000000@g.us')).toBe('group:120363025870000000');
  });

  it('applies dm allowlist and pairing logic', () => {
    expect(isWhatsAppDmAllowed({
      config: {
        dmPolicy: 'pairing',
        allowFrom: [],
        groupMode: 'closed',
        groups: {},
        groupRequireMentionDefault: true,
        sendReadReceipts: true,
      },
      userId: '+15551234567',
      paired: false,
    })).toBe(false);

    expect(isWhatsAppDmAllowed({
      config: {
        dmPolicy: 'closed',
        allowFrom: ['+15551234567'],
        groupMode: 'closed',
        groups: {},
        groupRequireMentionDefault: true,
        sendReadReceipts: true,
      },
      userId: '+15551234567',
      paired: false,
    })).toBe(true);
  });

  it('requires mentions when configured for groups', () => {
    const config = {
      dmPolicy: 'pairing' as const,
      allowFrom: [],
      groupMode: 'selected' as const,
      groups: {
        'group:123': { requireMention: true },
      },
      groupRequireMentionDefault: false,
      sendReadReceipts: true,
    };

    expect(evaluateWhatsAppGroupPolicy({
      config,
      groupIdOrKey: 'group:123',
      mentionedSelf: false,
      repliedToRecentBotMessage: false,
    }).allowed).toBe(false);

    expect(evaluateWhatsAppGroupPolicy({
      config,
      groupIdOrKey: 'group:123',
      mentionedSelf: true,
      repliedToRecentBotMessage: false,
    }).allowed).toBe(true);
  });
});
