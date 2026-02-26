import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeStore } from '../store.js';

describe('NodeStore', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-node-store-'));
    vi.stubEnv('XDG_CONFIG_HOME', tempRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('rejects pairing request without valid capabilities', async () => {
    const store = new NodeStore();
    await expect(store.createPairRequest('NoCaps', [] as any)).rejects.toThrow(/At least one valid capability/);
  });

  it('creates pairing request and approves node', async () => {
    const store = new NodeStore();
    const req = await store.createPairRequest('Pixel', ['notify', 'location']);
    expect(req.pairingCode).toHaveLength(6);

    const pending = await store.listPendingRequests();
    expect(pending).toHaveLength(1);

    const node = await store.approvePairRequest(req.requestId, req.pairingCode);
    expect(node.trusted).toBe(true);
    expect(node.capabilities).toEqual(['notify', 'location']);

    const nodes = await store.listNodes();
    expect(nodes).toHaveLength(1);
    expect((await store.listPendingRequests()).length).toBe(0);
  });
});
