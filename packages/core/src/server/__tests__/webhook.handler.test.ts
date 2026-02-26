import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleWebhookInboundRequest } from '../index.js';

describe('handleWebhookInboundRequest', () => {
  it('returns 405 for non-post methods', async () => {
    const req = new PassThrough() as any;
    req.method = 'GET';
    req.headers = {};

    const res = createResponseMock();
    const webhookService = { handleIncoming: vi.fn() } as any;

    await handleWebhookInboundRequest(req, res as any, webhookService, 'route-1');

    expect(res.statusCode).toBe(405);
    expect(webhookService.handleIncoming).not.toHaveBeenCalled();
  });

  it('passes payload + signature to service and returns status', async () => {
    const req = new PassThrough() as any;
    req.method = 'POST';
    req.headers = { 'x-keygate-signature': 'sha256=abc' };

    const res = createResponseMock();
    const webhookService = {
      handleIncoming: vi.fn(async () => ({ accepted: true, statusCode: 202, message: 'ok', route: { id: 'route-1' } })),
    } as any;

    const promise = handleWebhookInboundRequest(req, res as any, webhookService, 'route-1');
    req.write('{"x":1}');
    req.end();
    await promise;

    expect(webhookService.handleIncoming).toHaveBeenCalledWith('route-1', '{"x":1}', 'sha256=abc');
    expect(res.statusCode).toBe(202);
    expect(String(res.body)).toContain('"accepted":true');
  });
});

function createResponseMock() {
  const chunks: Buffer[] = [];
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(statusCode: number, headers: Record<string, string>) {
      this.statusCode = statusCode;
      this.headers = headers;
      return this;
    },
    end(payload?: string | Buffer) {
      if (payload) {
        chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
      }
      this.body = Buffer.concat(chunks).toString('utf8');
      return this;
    },
    setHeader() {},
  };
}
