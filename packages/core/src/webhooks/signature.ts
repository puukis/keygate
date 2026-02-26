import { createHmac, timingSafeEqual } from 'node:crypto';

export function computeWebhookSignature(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

export function verifyWebhookSignature(secret: string, payload: string, headerValue: string | undefined): boolean {
  if (!headerValue) {
    return false;
  }

  const normalized = headerValue.trim();
  const candidate = normalized.startsWith('sha256=') ? normalized.slice('sha256='.length) : normalized;
  if (!candidate || !/^[a-fA-F0-9]+$/.test(candidate)) {
    return false;
  }

  const expected = computeWebhookSignature(secret, payload);
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(candidate, 'hex'));
  } catch {
    return false;
  }
}
