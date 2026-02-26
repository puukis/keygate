import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryGetTool, memorySearchTool } from '../builtin/memory.js';

describe('memory tools', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-memory-tools-'));
    await fs.mkdir(path.join(tempDir, 'memory'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'MEMORY.md'), 'Long-term decision: keep pairing model strict.\n');
    await fs.writeFile(path.join(tempDir, 'memory', '2026-02-25.md'), 'Today we planned feature roadmap and testing policy.\n');
    vi.stubEnv('WORKSPACE_PATH', tempDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('memory_search returns structured snippets', async () => {
    const result = await memorySearchTool.handler({ query: 'strict pairing decision' } as any, {} as any);

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output) as { results: Array<{ path: string; startLine: number }> };
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results[0]?.path).toBeTruthy();
    expect(parsed.results[0]?.startLine).toBeGreaterThan(0);
  });

  it('memory_get returns selected line range', async () => {
    const result = await memoryGetTool.handler({ path: 'MEMORY.md', from: 1, lines: 1 } as any, {} as any);

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output) as { path: string; content: string };
    expect(parsed.path).toBe('MEMORY.md');
    expect(parsed.content).toContain('Long-term decision');
  });
});
