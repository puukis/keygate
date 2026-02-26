import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoutingRuleStore } from '../store.js';
import { RoutingService } from '../service.js';

describe('RoutingService', () => {
  let tempRoot = '';
  let workspaceRoot = '';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-routing-'));
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-routing-workspace-'));
    vi.stubEnv('XDG_CONFIG_HOME', tempRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
    if (workspaceRoot) await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('applies most specific matching rule', async () => {
    const store = new RoutingRuleStore();
    const service = new RoutingService(store, workspaceRoot);

    await service.createRule({ channel: 'discord', chatId: 'ch-1', agentKey: 'alpha' });
    await service.createRule({ channel: 'discord', chatId: 'ch-1', userId: 'u-1', agentKey: 'beta' });

    const resolved = await service.resolve({ channel: 'discord', chatId: 'ch-1', userId: 'u-1' });
    expect(resolved.agentKey).toBe('beta');
    expect(resolved.sessionId).toBe('discord:beta:ch-1');
    expect(resolved.workspacePath.endsWith(path.join('agents', 'beta'))).toBe(true);
  });

  it('falls back to default agent when no rule matches', async () => {
    const service = new RoutingService(new RoutingRuleStore(), workspaceRoot);
    const resolved = await service.resolve({ channel: 'slack', chatId: 'c1' });
    expect(resolved.agentKey).toBe('default');
    expect(resolved.sessionId).toBe('slack:default:c1');
  });
});
