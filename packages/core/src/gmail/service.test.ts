import { describe, expect, it, vi } from 'vitest';
import { GmailAutomationService } from './service.js';

function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const missingPadding = (4 - (padded.length % 4)) % 4;
  return Buffer.from(`${padded}${'='.repeat(missingPadding)}`, 'base64').toString('utf8');
}

describe('GmailAutomationService.sendEmail', () => {
  it('builds MIME-safe UTF-8 messages for non-ASCII input', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { raw: string };
      const mime = decodeBase64Url(payload.raw);

      expect(mime).toContain('From: sender@example.com');
      expect(mime).toContain('To: Puukis@gmx.de');
      expect(mime).toContain('Subject: =?UTF-8?B?SMOkbGxvIMOcYmVycmFzY2h1bmc=?=');
      expect(mime).toContain('Content-Type: multipart/alternative; boundary=');
      expect(mime).toContain('Content-Type: text/plain; charset=\"UTF-8\"');
      expect(mime).toContain('Content-Type: text/html; charset=\"UTF-8\"');
      expect(mime).toContain('Content-Transfer-Encoding: base64');
      expect(mime).toContain('U2Now7ZuZSBHcsO8w59l');
      expect(mime).toContain('PGRpdiBkaXI9Imx0ciI+PHA+U2Now7ZuZSBHcsO8w59lPC9wPjwvZGl2Pg==');

      return new Response(JSON.stringify({ id: 'msg-1', threadId: 'thread-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const service = new GmailAutomationService({ gmail: { clientId: 'test-client' } } as any, {
      store: {
        listAccounts: async () => [{
          id: 'sender',
          email: 'sender@example.com',
          tokenFilePath: '/tmp/sender.json',
          createdAt: '2026-03-11T00:00:00.000Z',
          updatedAt: '2026-03-11T00:00:00.000Z',
        }],
      } as any,
      fetchImpl: fetchImpl as typeof fetch,
    });
    vi.spyOn(service as any, 'getAccountAccessToken').mockResolvedValue('token-123');

    const result = await service.sendEmail({
      to: 'Puukis@gmx.de',
      subject: 'Hällo Überraschung',
      body: 'Schöne Grüße',
    });

    expect(result).toEqual({ messageId: 'msg-1', threadId: 'thread-1' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses plain 7bit MIME parts for ASCII content', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { raw: string };
      const mime = decodeBase64Url(payload.raw);

      expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"\r\n\r\nHello');
      expect(mime).toContain('Content-Type: text/html; charset="UTF-8"\r\n\r\n<div dir="ltr"><p>Hello</p></div>');
      expect(mime).not.toContain('Content-Transfer-Encoding: base64');

      return new Response(JSON.stringify({ id: 'msg-ascii' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const service = new GmailAutomationService({ gmail: { clientId: 'test-client' } } as any, {
      store: {
        listAccounts: async () => [{
          id: 'sender',
          email: 'sender@example.com',
          tokenFilePath: '/tmp/sender.json',
          createdAt: '2026-03-11T00:00:00.000Z',
          updatedAt: '2026-03-11T00:00:00.000Z',
        }],
      } as any,
      fetchImpl: fetchImpl as typeof fetch,
    });
    vi.spyOn(service as any, 'getAccountAccessToken').mockResolvedValue('token-123');

    const result = await service.sendEmail({
      to: 'Puukis@gmx.de',
      subject: 'Hello',
      body: 'Hello',
    });

    expect(result).toEqual({ messageId: 'msg-ascii', threadId: undefined });
  });

  it('turns literal escaped newlines into real body line breaks', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { raw: string };
      const mime = decodeBase64Url(payload.raw);

      expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"\r\n\r\nLine 1\r\nLine 2');
      expect(mime).not.toContain('Line 1\\nLine 2');

      return new Response(JSON.stringify({ id: 'msg-2' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const service = new GmailAutomationService({ gmail: { clientId: 'test-client' } } as any, {
      store: {
        listAccounts: async () => [{
          id: 'sender',
          email: 'sender@example.com',
          tokenFilePath: '/tmp/sender.json',
          createdAt: '2026-03-11T00:00:00.000Z',
          updatedAt: '2026-03-11T00:00:00.000Z',
        }],
      } as any,
      fetchImpl: fetchImpl as typeof fetch,
    });
    vi.spyOn(service as any, 'getAccountAccessToken').mockResolvedValue('token-123');

    const result = await service.sendEmail({
      to: 'Puukis@gmx.de',
      subject: 'Hello',
      body: 'Line 1\\nLine 2',
    });

    expect(result).toEqual({ messageId: 'msg-2', threadId: undefined });
  });

  it('rejects newline injection in headers', async () => {
    const service = new GmailAutomationService({ gmail: { clientId: 'test-client' } } as any, {
      store: {
        listAccounts: async () => [{
          id: 'sender',
          email: 'sender@example.com',
          tokenFilePath: '/tmp/sender.json',
          createdAt: '2026-03-11T00:00:00.000Z',
          updatedAt: '2026-03-11T00:00:00.000Z',
        }],
      } as any,
      fetchImpl: vi.fn() as typeof fetch,
    });
    vi.spyOn(service as any, 'getAccountAccessToken').mockResolvedValue('token-123');

    await expect(service.sendEmail({
      to: 'victim@example.com\r\nBcc: injected@example.com',
      subject: 'Hello',
      body: 'Body',
    })).rejects.toThrow('To must be a single line.');
  });
});
