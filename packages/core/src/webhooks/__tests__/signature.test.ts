import { describe, expect, it } from 'vitest';
import { computeWebhookSignature, verifyWebhookSignature } from '../signature.js';

describe('webhook signature', () => {
  it('verifies valid signature', () => {
    const body = JSON.stringify({ hello: 'world' });
    const secret = 'topsecret';
    const sig = computeWebhookSignature(secret, body);

    expect(verifyWebhookSignature(secret, body, `sha256=${sig}`)).toBe(true);
    expect(verifyWebhookSignature(secret, body, sig)).toBe(true);
  });

  it('rejects invalid signature', () => {
    const body = JSON.stringify({ hello: 'world' });
    expect(verifyWebhookSignature('x', body, 'sha256=deadbeef')).toBe(false);
  });
});
