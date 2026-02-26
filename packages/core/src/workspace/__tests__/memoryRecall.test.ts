import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMemorySnippet, normalizeMemoryRelativePath, searchMemoryFiles } from '../memoryRecall.js';

describe('memoryRecall', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-memory-recall-'));
    await fs.mkdir(path.join(tempDir, 'memory'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'MEMORY.md'), '# Memory\nImportant launch decision: enable DM pairing by default.\n');
    await fs.writeFile(path.join(tempDir, 'memory', '2026-02-25.md'), 'Today we fixed sqlite native module issues and rebuilt better-sqlite3.\n');
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('finds relevant snippets by semantic/keyword similarity', async () => {
    const result = await searchMemoryFiles({
      workspacePath: tempDir,
      query: 'how did we fix sqlite module problems',
      maxResults: 3,
    });

    expect(result.disabled).toBe(false);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.some((item) => item.path.includes('2026-02-25'))).toBe(true);
  });

  it('reads bounded snippet ranges', async () => {
    const snippet = await getMemorySnippet({
      workspacePath: tempDir,
      filePath: 'MEMORY.md',
      from: 2,
      lines: 1,
    });

    expect(snippet.path).toBe('MEMORY.md');
    expect(snippet.from).toBe(2);
    expect(snippet.to).toBe(2);
    expect(snippet.content).toContain('Important launch decision');
  });

  it('validates allowed memory paths', () => {
    expect(normalizeMemoryRelativePath('MEMORY.md')).toBe('MEMORY.md');
    expect(normalizeMemoryRelativePath('memory/2026-02-25.md')).toBe('memory/2026-02-25.md');
    expect(() => normalizeMemoryRelativePath('../secret.txt')).toThrow(/path must be MEMORY.md/);
  });
});
