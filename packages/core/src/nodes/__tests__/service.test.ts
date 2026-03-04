import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeService } from '../service.js';

describe('NodeService', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-node-service-'));
    vi.stubEnv('HOME', tempRoot);
    vi.stubEnv('USERPROFILE', tempRoot);
    vi.stubEnv('XDG_CONFIG_HOME', tempRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('denies high-risk invoke without ack and accepts with ack', async () => {
    const service = new NodeService();
    const req = await service.requestPairing('MacBook Node', ['screen', 'notify']);
    const node = await service.approvePairing(req.requestId, req.pairingCode);

    const denied = await service.invokeNode(node.id, 'screen', {});
    expect(denied.ok).toBe(false);
    expect(denied.deniedReason).toBe('high_risk_ack_required');

    const allowed = await service.invokeNode(node.id, 'screen', { highRiskAck: true, note: 'capture now' });
    expect(allowed.ok).toBe(true);
    expect(allowed.mode).toBe('stub');
  });

  it('denies capability not granted', async () => {
    const service = new NodeService();
    const req = await service.requestPairing('Phone', ['notify']);
    const node = await service.approvePairing(req.requestId, req.pairingCode);

    const result = await service.invokeNode(node.id, 'camera', { highRiskAck: true });
    expect(result.ok).toBe(false);
    expect(result.deniedReason).toBe('capability_not_granted');
  });
});
