import { describe, expect, it, vi } from 'vitest';
import { WebhookService } from '../service.js';
import { computeWebhookSignature } from '../signature.js';
import type { WebhookRoute } from '../store.js';

describe('WebhookService', () => {
  it('accepts signed webhook and dispatches to session', async () => {
    const route: WebhookRoute = {
      id: 'r1',
      name: 'github',
      sessionId: 'web:test',
      secret: 'abc',
      enabled: true,
      promptPrefix: '[WEBHOOK]',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const store = {
      getRoute: vi.fn(async () => route),
      listRoutes: vi.fn(),
      createRoute: vi.fn(),
      deleteRoute: vi.fn(),
      rotateSecret: vi.fn(),
    } as any;

    const dispatch = vi.fn(async () => undefined);
    const service = new WebhookService(store, dispatch);
    const body = JSON.stringify({ event: 'push' });
    const sig = computeWebhookSignature(route.secret, body);

    const result = await service.handleIncoming(route.id, body, `sha256=${sig}`);

    expect(result.accepted).toBe(true);
    expect(result.statusCode).toBe(202);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toBe('web:test');
    expect(String(dispatch.mock.calls[0][1])).toContain('push');
  });
});
