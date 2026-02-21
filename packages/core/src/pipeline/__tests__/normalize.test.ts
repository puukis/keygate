import { describe, expect, it } from 'vitest';
import { normalizeDiscordMessage, normalizeSlackMessage, normalizeTerminalMessage, normalizeWebMessage } from '../normalize.js';
import type { Channel } from '../../types.js';

function createChannel(type: Channel['type']): Channel {
  return {
    type,
    send: async () => undefined,
    sendStream: async () => undefined,
    requestConfirmation: async () => 'cancel',
  };
}

describe('normalize message helpers', () => {
  it('normalizes web messages with web session prefix', () => {
    const channel = createChannel('web');
    const normalized = normalizeWebMessage('abc', 'user-1', 'hello', channel);

    expect(normalized.sessionId).toBe('web:abc');
    expect(normalized.channelType).toBe('web');
    expect(normalized.content).toBe('hello');
  });

  it('forwards web attachments when present', () => {
    const channel = createChannel('web');
    const normalized = normalizeWebMessage(
      'abc',
      'user-1',
      'describe this image',
      channel,
      [{
        id: 'att-1',
        filename: 'capture.png',
        contentType: 'image/png',
        sizeBytes: 128,
        path: '/tmp/capture.png',
        url: '/api/uploads/image?sessionId=web%3Aabc&id=att-1',
      }]
    );

    expect(normalized.attachments).toEqual([
      expect.objectContaining({
        id: 'att-1',
        filename: 'capture.png',
      }),
    ]);
  });

  it('normalizes discord messages with discord session prefix', () => {
    const channel = createChannel('discord');
    const normalized = normalizeDiscordMessage('msg-1', 'chan-1', 'user-1', 'hello', channel);

    expect(normalized.id).toBe('msg-1');
    expect(normalized.sessionId).toBe('discord:chan-1');
    expect(normalized.channelType).toBe('discord');
  });

  it('normalizes terminal messages with terminal session prefix', () => {
    const channel = createChannel('terminal');
    const normalized = normalizeTerminalMessage('session-1', 'user-1', 'hello', channel);

    expect(normalized.sessionId).toBe('terminal:session-1');
    expect(normalized.channelType).toBe('terminal');
    expect(normalized.userId).toBe('user-1');
  });

  it('normalizes slack messages with slack session prefix', () => {
    const channel = createChannel('slack');
    const normalized = normalizeSlackMessage('msg-1', 'C12345', 'U99', 'hello from slack', channel);

    expect(normalized.id).toBe('msg-1');
    expect(normalized.sessionId).toBe('slack:C12345');
    expect(normalized.channelType).toBe('slack');
    expect(normalized.userId).toBe('U99');
    expect(normalized.content).toBe('hello from slack');
  });
});
