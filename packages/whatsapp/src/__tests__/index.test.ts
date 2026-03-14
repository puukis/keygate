import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isSelfChatJid,
  shouldIgnoreInboundWhatsAppMessage,
  shouldProcessWhatsAppUpsert,
  splitTextChunks,
  WhatsAppTypingIndicator,
} from '../index.js';

describe('whatsapp runtime helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('only processes live notify upserts from whatsapp', () => {
    expect(shouldProcessWhatsAppUpsert({
      upsertType: 'notify',
      fromMe: false,
      chatJid: '4917634521729@s.whatsapp.net',
      ownPhone: '+4917634521729',
      messageTimestampMs: null,
    })).toBe(true);

    expect(shouldProcessWhatsAppUpsert({
      upsertType: 'append',
      fromMe: false,
      chatJid: '4917634521729@s.whatsapp.net',
      ownPhone: '+4917634521729',
      messageTimestampMs: Date.now(),
    })).toBe(false);

    expect(shouldProcessWhatsAppUpsert({
      upsertType: 'append',
      fromMe: true,
      chatJid: '4917634521729@s.whatsapp.net',
      ownPhone: '+4917634521729',
      messageTimestampMs: 1_700_000_000_000,
      nowMs: 1_700_000_060_000,
    })).toBe(true);

    expect(shouldProcessWhatsAppUpsert({
      upsertType: 'append',
      fromMe: true,
      chatJid: '4917634521729@s.whatsapp.net',
      ownPhone: '+4917634521729',
      messageTimestampMs: 1_700_000_000_000,
      nowMs: 1_700_000_200_001,
    })).toBe(false);
  });

  it('sends composing presence while work is in progress', async () => {
    vi.useFakeTimers();
    const sendPresenceUpdate = vi.fn(async () => undefined);
    const indicator = new WhatsAppTypingIndicator(
      { sendPresenceUpdate } as unknown as ConstructorParameters<typeof WhatsAppTypingIndicator>[0],
      '4917634521729@s.whatsapp.net',
    );

    indicator.start();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(4_000);
    indicator.stop();
    await Promise.resolve();

    expect(sendPresenceUpdate.mock.calls).toEqual([
      ['composing', '4917634521729@s.whatsapp.net'],
      ['composing', '4917634521729@s.whatsapp.net'],
      ['paused', '4917634521729@s.whatsapp.net'],
    ]);
  });
});
