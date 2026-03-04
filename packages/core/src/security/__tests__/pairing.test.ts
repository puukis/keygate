import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  approvePairingCode,
  createOrGetPairingCode,
  isDmAllowedByPolicy,
  isUserPaired,
  listPendingPairings,
} from '../pairing.js';

describe('pairing', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-pairing-'));
    vi.stubEnv('HOME', tempRoot);
    vi.stubEnv('USERPROFILE', tempRoot);
    vi.stubEnv('XDG_CONFIG_HOME', tempRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('creates a pairing code and approves the user', async () => {
    const created = await createOrGetPairingCode('slack', 'U123');
    expect(created.code).toHaveLength(6);

    const pending = await listPendingPairings('slack');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.userId).toBe('U123');

    const approved = await approvePairingCode('slack', created.code);
    expect(approved.approved).toBe(true);
    expect(approved.userId).toBe('U123');

    expect(await isUserPaired('slack', 'U123')).toBe(true);
    expect(await listPendingPairings('slack')).toHaveLength(0);
  });

  it('returns same pending code for same user until expiration', async () => {
    const first = await createOrGetPairingCode('discord', 'user-1');
    const second = await createOrGetPairingCode('discord', 'user-1');
    expect(second.code).toBe(first.code);
    expect(second.created).toBe(false);
  });

  it('applies DM policy rules correctly', () => {
    expect(isDmAllowedByPolicy({ policy: 'open', userId: 'u1', allowFrom: [], paired: false })).toBe(true);
    expect(isDmAllowedByPolicy({ policy: 'pairing', userId: 'u1', allowFrom: [], paired: false })).toBe(false);
    expect(isDmAllowedByPolicy({ policy: 'pairing', userId: 'u1', allowFrom: [], paired: true })).toBe(true);
    expect(isDmAllowedByPolicy({ policy: 'closed', userId: 'u1', allowFrom: ['u1'], paired: false })).toBe(true);
    expect(isDmAllowedByPolicy({ policy: 'closed', userId: 'u1', allowFrom: ['*'], paired: false })).toBe(true);
  });

  it('auto-migrates pairing stores that predate whatsapp support', async () => {
    const configDir = path.join(tempRoot, '.keygate');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'pairing.json'),
      JSON.stringify({
        version: 1,
        allowlist: {
          discord: ['d1'],
          slack: ['s1'],
        },
        pending: [],
      }),
      'utf8'
    );

    expect(await isUserPaired('whatsapp', '+15551234567')).toBe(false);

    const created = await createOrGetPairingCode('whatsapp', '+15551234567');
    const approved = await approvePairingCode('whatsapp', created.code);
    expect(approved.approved).toBe(true);
    expect(await isUserPaired('whatsapp', '+15551234567')).toBe(true);
  });
});
