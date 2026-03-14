import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VectorStore } from '../vectorStore.js';

describe('VectorStore', () => {
  let tempDir = '';
  let dbPath = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-vectorstore-'));
    dbPath = path.join(tempDir, 'test-vectors.db');
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('creates database and tables', () => {
    const store = new VectorStore(3, dbPath);
    expect(store.totalChunks()).toBe(0);
    expect(store.indexedFiles()).toEqual([]);
    store.close();
  });

  it('upserts and retrieves chunks', async () => {
    const store = new VectorStore(3, dbPath);

    store.upsertFile('MEMORY.md', 'hash1', Date.now(), 100, 'memory');
    await store.upsertChunks([
      {
        id: 'chunk-1',
        path: 'MEMORY.md',
        startLine: 1,
        endLine: 5,
        text: 'Hello world',
        embedding: [0.1, 0.2, 0.3],
        model: 'test-model',
        source: 'memory' as const,
      },
    ]);

    expect(store.totalChunks()).toBe(1);
    expect(store.indexedFiles()).toContain('MEMORY.md');
    store.close();
  });

  it('performs vector search', async () => {
    const store = new VectorStore(3, dbPath);

    await store.upsertChunks([
      {
        id: 'chunk-1',
        path: 'MEMORY.md',
        startLine: 1,
        endLine: 5,
        text: 'TypeScript is great',
        embedding: [1, 0, 0],
        model: 'test',
        source: 'memory' as const,
      },
      {
        id: 'chunk-2',
        path: 'memory/notes.md',
        startLine: 1,
        endLine: 3,
        text: 'Python is also good',
        embedding: [0, 1, 0],
        model: 'test',
        source: 'memory' as const,
      },
    ]);

    // Query closest to chunk-1
    const results = await store.vectorSearch([1, 0.1, 0], { limit: 5 });
    expect(results.length).toBe(2);
    expect(results[0].path).toBe('MEMORY.md');
    store.close();
  });

  it('performs keyword search via FTS5', async () => {
    const store = new VectorStore(3, dbPath);

    await store.upsertChunks([
      {
        id: 'chunk-1',
        path: 'MEMORY.md',
        startLine: 1,
        endLine: 5,
        text: 'TypeScript compiler configuration',
        embedding: [1, 0, 0],
        model: 'test',
        source: 'memory' as const,
      },
      {
        id: 'chunk-2',
        path: 'memory/notes.md',
        startLine: 1,
        endLine: 3,
        text: 'Python runtime environment',
        embedding: [0, 1, 0],
        model: 'test',
        source: 'memory' as const,
      },
    ]);

    const results = store.keywordSearch('TypeScript compiler', { limit: 5 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].path).toBe('MEMORY.md');
    store.close();
  });

  it('filters by source', async () => {
    const store = new VectorStore(3, dbPath);

    await store.upsertChunks([
      {
        id: 'chunk-1',
        path: 'MEMORY.md',
        startLine: 1,
        endLine: 5,
        text: 'Memory file content',
        embedding: [1, 0, 0],
        model: 'test',
        source: 'memory' as const,
      },
      {
        id: 'chunk-2',
        path: 'session:abc',
        startLine: 1,
        endLine: 3,
        text: 'Session content',
        embedding: [0.9, 0.1, 0],
        model: 'test',
        source: 'session' as const,
      },
    ]);

    const memoryOnly = await store.vectorSearch([1, 0, 0], { limit: 5, source: 'memory' });
    expect(memoryOnly.every((r) => r.source === 'memory')).toBe(true);

    const sessionOnly = await store.vectorSearch([1, 0, 0], { limit: 5, source: 'session' });
    expect(sessionOnly.every((r) => r.source === 'session')).toBe(true);
    store.close();
  });

  it('deletes chunks by path', async () => {
    const store = new VectorStore(3, dbPath);

    await store.upsertChunks([
      {
        id: 'chunk-1',
        path: 'MEMORY.md',
        startLine: 1,
        endLine: 5,
        text: 'Content to delete',
        embedding: [1, 0, 0],
        model: 'test',
        source: 'memory' as const,
      },
    ]);

    expect(store.totalChunks()).toBe(1);
    await store.deleteByPath('MEMORY.md');
    expect(store.totalChunks()).toBe(0);
    store.close();
  });

  it('handles file hash tracking', () => {
    const store = new VectorStore(3, dbPath);

    expect(store.getFileHash('MEMORY.md')).toBeNull();
    store.upsertFile('MEMORY.md', 'abc123', Date.now(), 100, 'memory');
    expect(store.getFileHash('MEMORY.md')).toBe('abc123');
    store.close();
  });
});
