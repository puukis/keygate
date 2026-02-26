import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendApprovalAudit,
  assessToolRisk,
  hasRememberedApproval,
  rememberApproval,
} from '../riskEngine.js';
import type { Tool, ToolCall } from '../../types.js';

describe('riskEngine', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-risk-'));
    vi.stubEnv('XDG_CONFIG_HOME', tempRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('scores destructive shell commands as high risk', () => {
    const tool: Tool = {
      name: 'exec',
      description: 'shell',
      parameters: { type: 'object' },
      requiresConfirmation: true,
      type: 'shell',
      handler: async () => ({ success: true, output: '' }),
    };
    const call: ToolCall = { id: '1', name: 'exec', arguments: { command: 'sudo rm -rf /' } };

    const risk = assessToolRisk(tool, call);
    expect(risk.level).toBe('high');
    expect(risk.score).toBeGreaterThan(90);
  });

  it('remembers and reuses persisted approvals', async () => {
    await rememberApproval('sig-1', 'write_file', 'high');
    expect(await hasRememberedApproval('sig-1', 'high')).toBe(true);
    expect(await hasRememberedApproval('sig-1', 'medium')).toBe(true);
    expect(await hasRememberedApproval('sig-1', 'low')).toBe(true);
  });

  it('writes audit trail file', async () => {
    await appendApprovalAudit({
      sessionId: 'web:1',
      toolName: 'write_file',
      signature: 'sig-2',
      risk: { level: 'high', score: 80, reason: 'filesystem mutation' },
      decision: 'allow_once',
      detail: 'user confirmed',
    });

    const auditPath = path.join(tempRoot, 'keygate', 'approvals-audit.jsonl');
    const raw = await fs.readFile(auditPath, 'utf8');
    expect(raw).toContain('"tool":"write_file"');
    expect(raw).toContain('"decision":"allow_once"');
  });
});
