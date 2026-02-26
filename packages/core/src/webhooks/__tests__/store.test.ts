import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebhookStore } from '../store.js';

describe('WebhookStore', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-webhook-store-'));
    vi.stubEnv('XDG_CONFIG_HOME', tempRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid short secret', async () => {
    const store = new WebhookStore();
    await expect(store.createRoute({
      name: 'bad',
      sessionId: 'web:abc',
      secret: 'abc123',
    })).rejects.toThrow(/secret must be a hex string/);
  });

  it('creates, lists, rotates and deletes routes', async () => {
    const store = new WebhookStore();
    const created = await store.createRoute({ name: 'gitlab', sessionId: 'web:abc' });
    expect(created.secret.length).toBeGreaterThan(10);

    const list = await store.listRoutes();
    expect(list).toHaveLength(1);

    const updated = await store.updateRoute(created.id, { enabled: false, promptPrefix: '[UPDATED]' });
    expect(updated.enabled).toBe(false);
    expect(updated.promptPrefix).toBe('[UPDATED]');

    const rotated = await store.rotateSecret(created.id);
    expect(rotated.secret).not.toBe(created.secret);

    const deleted = await store.deleteRoute(created.id);
    expect(deleted).toBe(true);
    expect(await store.listRoutes()).toHaveLength(0);
  });
});
