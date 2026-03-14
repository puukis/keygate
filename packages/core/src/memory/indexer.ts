import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { chunkText, chunkSessionMessages } from './chunker.js';
import type { VectorStore, StoredChunk } from './vectorStore.js';
import type { EmbeddingProvider } from './embedding/types.js';

/**
 * Index workspace memory files (MEMORY.md + memory/*.md).
 * Skips files whose content hash hasn't changed since last index.
 */
export async function indexWorkspaceFiles(
  workspacePath: string,
  store: VectorStore,
  provider: EmbeddingProvider,
): Promise<{ indexed: number; skipped: number; removed: number }> {
  const files = await listMemoryFiles(workspacePath);
  const existingPaths = new Set(store.indexedFiles());
  let indexed = 0;
  let skipped = 0;
  let removed = 0;

  const currentPaths = new Set<string>();

  for (const relativePath of files) {
    currentPaths.add(relativePath);
    const absolutePath = path.join(workspacePath, relativePath);

    let content: string;
    let stat: { mtimeMs: number; size: number };
    try {
      [content, stat] = await Promise.all([
        fs.readFile(absolutePath, 'utf8'),
        fs.stat(absolutePath),
      ]);
    } catch {
      continue; // file disappeared between listing and reading
    }

    const hash = createHash('sha256').update(content).digest('hex');
    const storedHash = store.getFileHash(relativePath);

    if (storedHash === hash) {
      skipped++;
      continue;
    }

    // File is new or changed — re-chunk + re-embed
    await store.deleteByPath(relativePath);

    const chunks = chunkText(relativePath, content);
    if (chunks.length === 0) {
      skipped++;
      continue;
    }

    const texts = chunks.map((c) => c.text);
    const embeddings = await embedWithCache(texts, provider, store);

    const storedChunks: StoredChunk[] = chunks.map((chunk, i) => ({
      ...chunk,
      embedding: embeddings[i]!,
      model: provider.model,
      source: 'memory' as const,
    }));

    await store.upsertChunks(storedChunks);
    store.upsertFile(relativePath, hash, Math.floor(stat.mtimeMs), stat.size, 'memory');
    indexed++;
  }

  // Remove chunks for deleted files
  for (const existing of existingPaths) {
    if (!existing.startsWith('session:') && !currentPaths.has(existing)) {
      await store.deleteByPath(existing);
      removed++;
    }
  }

  return { indexed, skipped, removed };
}

/**
 * Index session transcripts from the database.
 * Only indexes sessions that have changed since the last index.
 */
export async function indexSessionTranscripts(
  sessions: Array<{ id: string; messages: Array<{ role: string; content: string }>; updatedAt: Date }>,
  store: VectorStore,
  provider: EmbeddingProvider,
): Promise<{ indexed: number; skipped: number }> {
  let indexed = 0;
  let skipped = 0;

  for (const session of sessions) {
    // Filter to user and assistant messages only
    const relevantMessages = session.messages.filter(
      (m) => m.role === 'user' || m.role === 'assistant',
    );
    if (relevantMessages.length === 0) {
      skipped++;
      continue;
    }

    const sessionPath = `session:${session.id}`;
    const contentForHash = relevantMessages.map((m) => `${m.role}:${m.content}`).join('\n');
    const hash = createHash('sha256').update(contentForHash).digest('hex');
    const storedHash = store.getFileHash(sessionPath);

    if (storedHash === hash) {
      skipped++;
      continue;
    }

    await store.deleteByPath(sessionPath);

    const chunks = chunkSessionMessages(session.id, relevantMessages);
    if (chunks.length === 0) {
      skipped++;
      continue;
    }

    const texts = chunks.map((c) => c.text);
    const embeddings = await embedWithCache(texts, provider, store);

    const storedChunks: StoredChunk[] = chunks.map((chunk, i) => ({
      ...chunk,
      embedding: embeddings[i]!,
      model: provider.model,
      source: 'session' as const,
    }));

    await store.upsertChunks(storedChunks);
    store.upsertFile(sessionPath, hash, Date.now(), contentForHash.length, 'session');
    indexed++;
  }

  return { indexed, skipped };
}

// ── Helpers ───────────────────────────────────────────────────

async function listMemoryFiles(workspacePath: string): Promise<string[]> {
  const files: string[] = [];

  try {
    await fs.access(path.join(workspacePath, 'MEMORY.md'));
    files.push('MEMORY.md');
  } catch {
    // no MEMORY.md
  }

  try {
    const entries = await fs.readdir(path.join(workspacePath, 'memory'), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(`memory/${entry.name}`);
      }
    }
  } catch {
    // no memory/ directory
  }

  return files.sort();
}

/**
 * Embed texts using the provider, with a per-text hash cache to avoid
 * re-embedding identical content.
 */
async function embedWithCache(
  texts: string[],
  provider: EmbeddingProvider,
  store: VectorStore,
): Promise<number[][]> {
  const results: (number[] | null)[] = new Array(texts.length).fill(null);
  const uncachedIndices: number[] = [];
  const uncachedTexts: string[] = [];

  for (let i = 0; i < texts.length; i++) {
    const textHash = createHash('sha256').update(texts[i]!).digest('hex').slice(0, 32);
    const cached = store.getCachedEmbedding(provider.id, provider.model, textHash);
    if (cached) {
      results[i] = cached;
    } else {
      uncachedIndices.push(i);
      uncachedTexts.push(texts[i]!);
    }
  }

  if (uncachedTexts.length > 0) {
    const embeddings = await provider.embedBatch(uncachedTexts);
    for (let j = 0; j < uncachedIndices.length; j++) {
      const idx = uncachedIndices[j]!;
      const embedding = embeddings[j]!;
      results[idx] = embedding;

      const textHash = createHash('sha256').update(texts[idx]!).digest('hex').slice(0, 32);
      store.setCachedEmbedding(provider.id, provider.model, textHash, embedding);
    }
  }

  return results as number[][];
}
