import { describe, expect, it } from 'vitest';
import {
  isSelfChatJid,
  shouldIgnoreInboundWhatsAppMessage,
  splitTextChunks,
} from '../index.js';

describe('whatsapp runtime helpers', () => {
  it('splits long outbound messages into stable chunks', () => {
    const input = `hello ${'word '.repeat(1200)}`;
    const chunks = splitTextChunks(input);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 3500)).toBe(true);
    expect(chunks.join(' ')).toContain('hello');
  });

  it('treats note-to-self chat as a valid self chat', () => {
    expect(isSelfChatJid('4917634521729@s.whatsapp.net', '+4917634521729')).toBe(true);
    expect(isSelfChatJid('120363025870000000@g.us', '+4917634521729')).toBe(false);
  });

  it('processes self-authored note-to-self messages and ignores status broadcasts', () => {
    expect(shouldIgnoreInboundWhatsAppMessage({
      chatJid: '4917634521729@s.whatsapp.net',
      messageId: 'user-msg-1',
      fromMe: true,
      ownPhone: '+4917634521729',
    })).toBe(false);

    expect(shouldIgnoreInboundWhatsAppMessage({
      chatJid: 'status@broadcast',
      messageId: 'status-msg-1',
      fromMe: false,
      ownPhone: '+4917634521729',
    })).toBe(true);
  });
});
