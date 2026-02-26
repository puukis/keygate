import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoutingRuleStore } from '../store.js';

describe('RoutingRuleStore', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-routing-store-'));
    vi.stubEnv('XDG_CONFIG_HOME', tempRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('creates and deletes routing rules', async () => {
    const store = new RoutingRuleStore();
    const rule = await store.createRule({ channel: 'discord', chatId: 'ch1', agentKey: 'Team A' });

    expect(rule.agentKey).toBe('team-a');
    expect((await store.listRules()).length).toBe(1);

    const deleted = await store.deleteRule(rule.id);
    expect(deleted).toBe(true);
    expect((await store.listRules()).length).toBe(0);
  });
});
