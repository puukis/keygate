import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as lancedb from '@lancedb/lancedb';
import type { Connection as LanceConnection, Table as LanceTable } from '@lancedb/lancedb';
import { getConfigDir } from '../config/env.js';
import type { MemoryBackendConfig } from './embedding/types.js';

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

export interface VectorStoreOptions {
  dbPath?: string;
  backend?: MemoryBackendConfig;
}

export interface VectorBackendStatus {
  active: 'sqlite-vec' | 'lancedb';
  target: 'sqlite-vec' | 'lancedb';
  migrationPhase: 'idle' | 'backfilling' | 'ready';
  lanceRows: number;
}

export class VectorStore {
  private db: Database.Database;
  private readonly dimensions: number;
  private readonly targetBackend: 'sqlite-vec' | 'lancedb';
  private activeBackend: 'sqlite-vec' | 'lancedb';
  private readonly lanceDbPath: string;
  private lanceConnection: LanceConnection | null = null;
  private lanceTable: LanceTable | null = null;
  private lanceInitPromise: Promise<void> | null = null;
  private migrationPhase: VectorBackendStatus['migrationPhase'] = 'idle';
  private lanceRowCount = 0;

  constructor(dimensions: number, options: string | VectorStoreOptions = {}) {
    const normalizedOptions: VectorStoreOptions = typeof options === 'string'
      ? { dbPath: options }
      : options;
    const defaultPath = path.join(getConfigDir(), 'memory-vectors.db');
    const targetPath = normalizedOptions.dbPath ?? defaultPath;

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    this.db = new Database(targetPath);
    this.dimensions = dimensions;
    this.targetBackend = normalizedOptions.backend?.active ?? 'sqlite-vec';
    this.activeBackend = this.targetBackend === 'sqlite-vec' ? 'sqlite-vec' : 'sqlite-vec';
    this.lanceDbPath = normalizedOptions.backend?.lancedbPath ?? path.join(getConfigDir(), 'memory-lancedb');

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
        embedding BLOB,
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

    this.ensureMemoryChunksEmbeddingColumn();

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[${this.dimensions}]
      );
    `);

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
        id UNINDEXED,
        text,
        source UNINDEXED,
        content='memory_chunks',
        content_rowid='rowid'
      );
    `);

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

  private ensureMemoryChunksEmbeddingColumn(): void {
    type ColumnInfo = { name: string };
    const columns = this.db.prepare('PRAGMA table_info(memory_chunks)').all() as ColumnInfo[];
    if (columns.some((column) => column.name === 'embedding')) {
      return;
    }
    this.db.exec('ALTER TABLE memory_chunks ADD COLUMN embedding BLOB');
  }

  async prepareTargetBackend(): Promise<void> {
    if (this.targetBackend !== 'lancedb') {
      this.activeBackend = 'sqlite-vec';
      this.migrationPhase = 'idle';
      return;
    }

    await this.ensureLanceReady();
    this.migrationPhase = 'backfilling';
  }

  async activateTargetBackend(): Promise<void> {
    if (this.targetBackend !== 'lancedb') {
      this.activeBackend = 'sqlite-vec';
      this.migrationPhase = 'idle';
      return;
    }

    await this.ensureLanceReady();
    this.activeBackend = 'lancedb';
    this.migrationPhase = 'ready';
  }

  status(): VectorBackendStatus {
    return {
      active: this.activeBackend,
      target: this.targetBackend,
      migrationPhase: this.migrationPhase,
      lanceRows: this.lanceRowCount,
    };
  }

  async upsertChunks(chunks: StoredChunk[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }

    const upsertChunk = this.db.prepare(`
      INSERT INTO memory_chunks (id, path, start_line, end_line, text, model, source, embedding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path,
        start_line = excluded.start_line,
        end_line = excluded.end_line,
        text = excluded.text,
        model = excluded.model,
        source = excluded.source,
        embedding = excluded.embedding,
        updated_at = excluded.updated_at
    `);
    const deleteVec = this.db.prepare('DELETE FROM memory_chunks_vec WHERE id = ?');
    const insertVec = this.db.prepare('INSERT INTO memory_chunks_vec (id, embedding) VALUES (?, ?)');
    const now = new Date().toISOString();

    const transaction = this.db.transaction((items: StoredChunk[]) => {
      for (const chunk of items) {
        const embeddingBuffer = float32Buffer(chunk.embedding);
        upsertChunk.run(
          chunk.id,
          chunk.path,
          chunk.startLine,
          chunk.endLine,
          chunk.text,
          chunk.model,
          chunk.source,
          embeddingBuffer,
          now,
        );
        deleteVec.run(chunk.id);
        insertVec.run(chunk.id, embeddingBuffer);
      }
    });
    transaction(chunks);

    if (this.targetBackend === 'lancedb') {
      await this.ensureLanceReady();
      await this.upsertLanceRows(chunks);
    }
  }

  async vectorSearch(embedding: number[], opts: {
    limit?: number;
    source?: 'memory' | 'session';
  } = {}): Promise<VectorSearchResult[]> {
    if (this.activeBackend === 'lancedb') {
      return this.lanceVectorSearch(embedding, opts);
    }
    return this.sqliteVectorSearch(embedding, opts);
  }

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

    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      text: row.text,
      score: bm25RankToScore(row.rank),
      source: row.source as 'memory' | 'session',
    }));
  }

  getFileHash(filePath: string): string | null {
    const row = this.db.prepare('SELECT hash FROM memory_files WHERE path = ?').get(filePath) as { hash: string } | undefined;
    return row?.hash ?? null;
  }

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

  async deleteByPath(filePath: string): Promise<void> {
    const chunkIds = this.db.prepare('SELECT id FROM memory_chunks WHERE path = ?').all(filePath) as { id: string }[];
    const transaction = this.db.transaction(() => {
      const deleteVec = this.db.prepare('DELETE FROM memory_chunks_vec WHERE id = ?');
      for (const { id } of chunkIds) {
        deleteVec.run(id);
      }
      this.db.prepare('DELETE FROM memory_chunks WHERE path = ?').run(filePath);
      this.db.prepare('DELETE FROM memory_files WHERE path = ?').run(filePath);
    });
    transaction();

    if (this.targetBackend === 'lancedb' && chunkIds.length > 0) {
      await this.ensureLanceReady();
      await this.deleteLanceRows(chunkIds.map((row) => row.id));
    }
  }

  getCachedEmbedding(provider: string, model: string, textHash: string): number[] | null {
    const row = this.db.prepare(
      'SELECT embedding, dims FROM embedding_cache WHERE provider = ? AND model = ? AND text_hash = ?',
    ).get(provider, model, textHash) as { embedding: Buffer; dims: number } | undefined;

    if (!row) return null;
    return bufferToFloat32(row.embedding, row.dims);
  }

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

  totalChunks(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM memory_chunks').get() as { count: number };
    return row.count;
  }

  indexedFiles(): string[] {
    const rows = this.db.prepare('SELECT path FROM memory_files ORDER BY path').all() as { path: string }[];
    return rows.map((row) => row.path);
  }

  close(): void {
    this.lanceTable?.close();
    this.lanceConnection?.close();
    this.db.close();
  }

  private sqliteVectorSearch(embedding: number[], opts: {
    limit?: number;
    source?: 'memory' | 'session';
  }): VectorSearchResult[] {
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

    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      text: row.text,
      score: 1 - row.distance,
      source: row.source as 'memory' | 'session',
    }));
  }

  private async lanceVectorSearch(embedding: number[], opts: {
    limit?: number;
    source?: 'memory' | 'session';
  }): Promise<VectorSearchResult[]> {
    await this.ensureLanceReady();
    const table = this.lanceTable;
    if (!table) {
      return this.sqliteVectorSearch(embedding, opts);
    }

    let query = table
      .search(embedding)
      .select(['id', 'path', 'start_line', 'end_line', 'text', 'source', '_distance'])
      .limit(opts.limit ?? 20);

    if (opts.source) {
      query = query.where(`source = '${escapeSqlString(opts.source)}'`);
    }

    const rows = await query.toArray();
    return rows.map((row) => {
      const distance = Number((row as Record<string, unknown>)['_distance'] ?? 1);
      return {
        id: String((row as Record<string, unknown>)['id'] ?? ''),
        path: String((row as Record<string, unknown>)['path'] ?? ''),
        startLine: Number((row as Record<string, unknown>)['start_line'] ?? 1),
        endLine: Number((row as Record<string, unknown>)['end_line'] ?? 1),
        text: String((row as Record<string, unknown>)['text'] ?? ''),
        score: 1 / (1 + Math.max(0, distance)),
        source: String((row as Record<string, unknown>)['source'] ?? 'memory') as 'memory' | 'session',
      };
    });
  }

  private async ensureLanceReady(): Promise<void> {
    if (this.lanceTable && this.lanceConnection) {
      return;
    }
    if (this.lanceInitPromise) {
      await this.lanceInitPromise;
      return;
    }

    this.lanceInitPromise = (async () => {
      fs.mkdirSync(this.lanceDbPath, { recursive: true });
      this.lanceConnection = await lancedb.connect(this.lanceDbPath);
      const tableNames = await this.lanceConnection.tableNames();
      if (tableNames.includes('memory_chunks')) {
        this.lanceTable = await this.lanceConnection.openTable('memory_chunks');
      } else {
        this.lanceTable = await this.lanceConnection.createTable('memory_chunks', [{
          id: '__bootstrap__',
          path: '__bootstrap__',
          start_line: 0,
          end_line: 0,
          text: '',
          model: 'bootstrap',
          source: 'memory',
          vector: new Array(this.dimensions).fill(0),
        }]);
        await this.lanceTable.delete("id = '__bootstrap__'");
      }
      this.lanceRowCount = await this.lanceTable.countRows();
    })();

    try {
      await this.lanceInitPromise;
    } finally {
      this.lanceInitPromise = null;
    }
  }

  async backfillLanceFromSqlite(): Promise<{ migrated: number }> {
    if (this.targetBackend !== 'lancedb') {
      return { migrated: 0 };
    }

    await this.ensureLanceReady();
    if (!this.lanceTable) {
      return { migrated: 0 };
    }

    const rows = this.db.prepare(`
      SELECT id, path, start_line, end_line, text, model, source, embedding
      FROM memory_chunks
      ORDER BY id
    `).all() as Array<{
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      model: string;
      source: 'memory' | 'session';
      embedding: Buffer | null;
    }>;

    const chunks = rows
      .filter((row) => row.embedding && row.embedding.length > 0)
      .map((row) => ({
        id: row.id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        text: row.text,
        model: row.model,
        source: row.source,
        embedding: bufferToFloat32(row.embedding!, this.dimensions),
      }));

    if (chunks.length === 0) {
      return { migrated: 0 };
    }

    await this.upsertLanceRows(chunks);
    this.migrationPhase = 'ready';
    return { migrated: chunks.length };
  }

  private async upsertLanceRows(chunks: StoredChunk[]): Promise<void> {
    if (!this.lanceTable) {
      return;
    }

    const ids = chunks.map((chunk) => chunk.id);
    await this.deleteLanceRows(ids);
    await this.lanceTable.add(chunks.map((chunk) => ({
      id: chunk.id,
      path: chunk.path,
      start_line: chunk.startLine,
      end_line: chunk.endLine,
      text: chunk.text,
      model: chunk.model,
      source: chunk.source,
      vector: chunk.embedding,
    })));
    this.lanceRowCount = await this.lanceTable.countRows();
  }

  private async deleteLanceRows(ids: string[]): Promise<void> {
    if (!this.lanceTable || ids.length === 0) {
      return;
    }

    const predicates: string[] = [];
    for (let index = 0; index < ids.length; index += 50) {
      const batch = ids.slice(index, index + 50).map((id) => `'${escapeSqlString(id)}'`).join(', ');
      predicates.push(`id IN (${batch})`);
    }
    for (const predicate of predicates) {
      await this.lanceTable.delete(predicate);
    }
    this.lanceRowCount = await this.lanceTable.countRows();
  }
}

function float32Buffer(arr: number[]): Buffer {
  const buf = Buffer.alloc(arr.length * 4);
  for (let i = 0; i < arr.length; i += 1) {
    buf.writeFloatLE(arr[i]!, i * 4);
  }
  return buf;
}

function bufferToFloat32(buf: Buffer, dims: number): number[] {
  const result: number[] = new Array(dims);
  for (let i = 0; i < dims; i += 1) {
    result[i] = buf.readFloatLE(i * 4);
  }
  return result;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function buildFtsQuery(query: string): string {
  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'is', 'are', 'was', 'were', 'be', 'been',
    'of', 'to', 'in', 'on', 'for', 'with', 'as', 'at', 'by', 'from', 'that', 'this', 'it', 'its',
    'we', 'you', 'they', 'he', 'she', 'i', 'me', 'my', 'our', 'your', 'their', 'not', 'do', 'does',
  ]);

  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));

  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${token}"`).join(' OR ');
}

function bm25RankToScore(rank: number): number {
  return 1 / (1 + Math.abs(rank));
}
