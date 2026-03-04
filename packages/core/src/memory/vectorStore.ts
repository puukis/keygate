import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { getConfigDir } from '../config/env.js';

export interface StoredChunk {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  embedding: number[];
  model: string;
  source: 'memory' | 'session';
}

export interface VectorSearchResult {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
  source: 'memory' | 'session';
}

export class VectorStore {
  private db: Database.Database;
  private dimensions: number;

  constructor(dimensions: number, dbPath?: string) {
    const defaultPath = path.join(getConfigDir(), 'memory-vectors.db');
    const targetPath = dbPath ?? defaultPath;

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    this.db = new Database(targetPath);
    this.dimensions = dimensions;

    // Load sqlite-vec extension
    sqliteVec.load(this.db);

    this.db.pragma('journal_mode = WAL');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory'
      );

      CREATE TABLE IF NOT EXISTS memory_chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text TEXT NOT NULL,
        model TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_path ON memory_chunks(path);
      CREATE INDEX IF NOT EXISTS idx_chunks_source ON memory_chunks(source);

      CREATE TABLE IF NOT EXISTS embedding_cache (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        embedding BLOB NOT NULL,
        dims INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, model, text_hash)
      );

      CREATE INDEX IF NOT EXISTS idx_cache_updated ON embedding_cache(updated_at);
    `);

    // Create the sqlite-vec virtual table for vector search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[${this.dimensions}]
      );
    `);

    // Create the FTS5 virtual table for keyword search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
        id UNINDEXED,
        text,
        source UNINDEXED,
        content='memory_chunks',
        content_rowid='rowid'
      );
    `);

    // Set up triggers to keep FTS in sync with the chunks table
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memory_chunks_ai AFTER INSERT ON memory_chunks BEGIN
        INSERT INTO memory_chunks_fts(rowid, id, text, source)
          VALUES (new.rowid, new.id, new.text, new.source);
      END;

      CREATE TRIGGER IF NOT EXISTS memory_chunks_ad AFTER DELETE ON memory_chunks BEGIN
        INSERT INTO memory_chunks_fts(memory_chunks_fts, rowid, id, text, source)
          VALUES ('delete', old.rowid, old.id, old.text, old.source);
      END;

      CREATE TRIGGER IF NOT EXISTS memory_chunks_au AFTER UPDATE ON memory_chunks BEGIN
        INSERT INTO memory_chunks_fts(memory_chunks_fts, rowid, id, text, source)
          VALUES ('delete', old.rowid, old.id, old.text, old.source);
        INSERT INTO memory_chunks_fts(rowid, id, text, source)
          VALUES (new.rowid, new.id, new.text, new.source);
      END;
    `);
  }

  /**
   * Upsert chunks with their embeddings into both the chunks table and vec table.
   * Uses a transaction for atomicity.
   */
  upsertChunks(chunks: StoredChunk[]): void {
    if (chunks.length === 0) return;

    const upsertChunk = this.db.prepare(`
      INSERT INTO memory_chunks (id, path, start_line, end_line, text, model, source, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path,
        start_line = excluded.start_line,
        end_line = excluded.end_line,
        text = excluded.text,
        model = excluded.model,
        source = excluded.source,
        updated_at = excluded.updated_at
    `);

    const deleteVec = this.db.prepare(`DELETE FROM memory_chunks_vec WHERE id = ?`);
    const insertVec = this.db.prepare(`INSERT INTO memory_chunks_vec (id, embedding) VALUES (?, ?)`);

    const now = new Date().toISOString();

    const transaction = this.db.transaction((items: StoredChunk[]) => {
      for (const chunk of items) {
        upsertChunk.run(
          chunk.id, chunk.path, chunk.startLine, chunk.endLine,
          chunk.text, chunk.model, chunk.source, now,
        );
        // sqlite-vec requires float32 buffer
        const buf = float32Buffer(chunk.embedding);
        deleteVec.run(chunk.id);
        insertVec.run(chunk.id, buf);
      }
    });

    transaction(chunks);
  }

  /**
   * Search by vector similarity using cosine distance.
   */
  vectorSearch(embedding: number[], opts: {
    limit?: number;
    source?: 'memory' | 'session';
  } = {}): VectorSearchResult[] {
    const limit = opts.limit ?? 20;
    const buf = float32Buffer(embedding);

    type Row = {
      id: string;
      distance: number;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      source: string;
    };

    let rows: Row[];

    if (opts.source) {
      rows = this.db.prepare(`
        SELECT v.id, v.distance, c.path, c.start_line, c.end_line, c.text, c.source
        FROM memory_chunks_vec v
        JOIN memory_chunks c ON c.id = v.id
        WHERE v.embedding MATCH ? AND k = ?
          AND c.source = ?
        ORDER BY v.distance ASC
      `).all(buf, limit, opts.source) as Row[];
    } else {
      rows = this.db.prepare(`
        SELECT v.id, v.distance, c.path, c.start_line, c.end_line, c.text, c.source
        FROM memory_chunks_vec v
        JOIN memory_chunks c ON c.id = v.id
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance ASC
      `).all(buf, limit) as Row[];
    }

    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      startLine: r.start_line,
      endLine: r.end_line,
      text: r.text,
      score: 1 - r.distance, // cosine distance → similarity
      source: r.source as 'memory' | 'session',
    }));
  }

  /**
   * Full-text keyword search using BM25 ranking.
   */
  keywordSearch(query: string, opts: {
    limit?: number;
    source?: 'memory' | 'session';
  } = {}): VectorSearchResult[] {
    const limit = opts.limit ?? 20;
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    type Row = {
      id: string;
      rank: number;
      text: string;
      path: string;
      start_line: number;
      end_line: number;
      source: string;
    };

    let rows: Row[];

    if (opts.source) {
      rows = this.db.prepare(`
        SELECT f.id, f.rank, c.path, c.start_line, c.end_line, c.text, c.source
        FROM memory_chunks_fts f
        JOIN memory_chunks c ON c.id = f.id
        WHERE memory_chunks_fts MATCH ? AND f.source = ?
        ORDER BY f.rank
        LIMIT ?
      `).all(ftsQuery, opts.source, limit) as Row[];
    } else {
      rows = this.db.prepare(`
        SELECT f.id, f.rank, c.path, c.start_line, c.end_line, c.text, c.source
        FROM memory_chunks_fts f
        JOIN memory_chunks c ON c.id = f.id
        WHERE memory_chunks_fts MATCH ?
        ORDER BY f.rank
        LIMIT ?
      `).all(ftsQuery, limit) as Row[];
    }

    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      startLine: r.start_line,
      endLine: r.end_line,
      text: r.text,
      score: bm25RankToScore(r.rank),
      source: r.source as 'memory' | 'session',
    }));
  }

  /**
   * Get the stored hash for a file path (to detect changes).
   */
  getFileHash(filePath: string): string | null {
    const row = this.db.prepare('SELECT hash FROM memory_files WHERE path = ?').get(filePath) as { hash: string } | undefined;
    return row?.hash ?? null;
  }

  /**
   * Update or insert file metadata.
   */
  upsertFile(filePath: string, hash: string, mtime: number, size: number, source: 'memory' | 'session'): void {
    this.db.prepare(`
      INSERT INTO memory_files (path, hash, mtime, size, source)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        hash = excluded.hash,
        mtime = excluded.mtime,
        size = excluded.size,
        source = excluded.source
    `).run(filePath, hash, mtime, size, source);
  }

  /**
   * Delete all chunks and metadata for a given file path.
   */
  deleteByPath(filePath: string): void {
    const transaction = this.db.transaction(() => {
      const chunkIds = this.db.prepare('SELECT id FROM memory_chunks WHERE path = ?').all(filePath) as { id: string }[];
      const deleteVec = this.db.prepare('DELETE FROM memory_chunks_vec WHERE id = ?');
      for (const { id } of chunkIds) {
        deleteVec.run(id);
      }
      this.db.prepare('DELETE FROM memory_chunks WHERE path = ?').run(filePath);
      this.db.prepare('DELETE FROM memory_files WHERE path = ?').run(filePath);
    });
    transaction();
  }

  /**
   * Get a cached embedding if available.
   */
  getCachedEmbedding(provider: string, model: string, textHash: string): number[] | null {
    const row = this.db.prepare(
      'SELECT embedding, dims FROM embedding_cache WHERE provider = ? AND model = ? AND text_hash = ?',
    ).get(provider, model, textHash) as { embedding: Buffer; dims: number } | undefined;

    if (!row) return null;
    return bufferToFloat32(row.embedding, row.dims);
  }

  /**
   * Cache an embedding for later reuse.
   */
  setCachedEmbedding(provider: string, model: string, textHash: string, embedding: number[]): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO embedding_cache (provider, model, text_hash, embedding, dims, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, model, text_hash) DO UPDATE SET
        embedding = excluded.embedding,
        dims = excluded.dims,
        updated_at = excluded.updated_at
    `).run(provider, model, textHash, float32Buffer(embedding), embedding.length, now);
  }

  /**
   * Get total number of indexed chunks.
   */
  totalChunks(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM memory_chunks').get() as { count: number };
    return row.count;
  }

  /**
   * Get list of all indexed file paths.
   */
  indexedFiles(): string[] {
    const rows = this.db.prepare('SELECT path FROM memory_files ORDER BY path').all() as { path: string }[];
    return rows.map((r) => r.path);
  }

  close(): void {
    this.db.close();
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function float32Buffer(arr: number[]): Buffer {
  const buf = Buffer.alloc(arr.length * 4);
  for (let i = 0; i < arr.length; i++) {
    buf.writeFloatLE(arr[i]!, i * 4);
  }
  return buf;
}

function bufferToFloat32(buf: Buffer, dims: number): number[] {
  const result: number[] = new Array(dims);
  for (let i = 0; i < dims; i++) {
    result[i] = buf.readFloatLE(i * 4);
  }
  return result;
}

/**
 * Convert a natural-language query into an FTS5 MATCH expression.
 * Extracts individual words, removes short/stop words.
 */
function buildFtsQuery(query: string): string {
  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'is', 'are', 'was', 'were', 'be', 'been',
    'of', 'to', 'in', 'on', 'for', 'with', 'as', 'at', 'by', 'from', 'that', 'this', 'it', 'its',
    'we', 'you', 'they', 'he', 'she', 'i', 'me', 'my', 'our', 'your', 'their', 'not', 'do', 'does',
  ]);

  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

  if (tokens.length === 0) return '';

  // Quote each token and join with OR for broader matching
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

/**
 * Convert FTS5 BM25 rank (negative, lower is better) to a 0–1 score.
 */
function bm25RankToScore(rank: number): number {
  return 1 / (1 + Math.abs(rank));
}
