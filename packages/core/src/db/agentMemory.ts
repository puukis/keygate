import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

// ── Types ──

export interface AgentMemory {
  id: number;
  namespace: string;
  key: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemorySearchResult {
  memories: AgentMemory[];
  total: number;
}

// ── AgentMemoryStore ──

export class AgentMemoryStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const defaultPath = path.join(os.homedir(), '.config', 'keygate', 'agent-memory.db');
    const targetPath = dbPath ?? defaultPath;

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    this.db = new Database(targetPath);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        namespace TEXT NOT NULL DEFAULT 'general',
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(namespace, key)
      );

      CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace);
      CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
    `);
  }

  /**
   * Save or update a memory entry. Upserts by (namespace, key).
   */
  set(namespace: string, key: string, content: string): AgentMemory {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO memories (namespace, key, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(namespace, key) DO UPDATE SET
        content = excluded.content,
        updated_at = excluded.updated_at
    `);
    stmt.run(namespace, key, content, now, now);

    return this.get(namespace, key)!;
  }

  /**
   * Get a single memory by namespace and key.
   */
  get(namespace: string, key: string): AgentMemory | null {
    type Row = {
      id: number;
      namespace: string;
      key: string;
      content: string;
      created_at: string;
      updated_at: string;
    };

    const stmt = this.db.prepare('SELECT * FROM memories WHERE namespace = ? AND key = ?');
    const row = stmt.get(namespace, key) as Row | undefined;

    if (!row) return null;

    return {
      id: row.id,
      namespace: row.namespace,
      key: row.key,
      content: row.content,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  /**
   * List all memories in a namespace, ordered by most recently updated.
   */
  list(namespace?: string, limit = 100): AgentMemory[] {
    type Row = {
      id: number;
      namespace: string;
      key: string;
      content: string;
      created_at: string;
      updated_at: string;
    };

    const rows = namespace
      ? (this.db.prepare('SELECT * FROM memories WHERE namespace = ? ORDER BY updated_at DESC LIMIT ?').all(namespace, limit) as Row[])
      : (this.db.prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?').all(limit) as Row[]);

    return rows.map(rowToMemory);
  }

  /**
   * Search memories by content or key substring match.
   */
  search(query: string, options: { namespace?: string; limit?: number } = {}): MemorySearchResult {
    type Row = {
      id: number;
      namespace: string;
      key: string;
      content: string;
      created_at: string;
      updated_at: string;
    };
    type CountRow = {
      total: number;
    };

    const limit = options.limit ?? 50;
    const pattern = `%${query}%`;

    let rows: Row[];
    let total: number;

    if (options.namespace) {
      rows = this.db.prepare(
        'SELECT * FROM memories WHERE namespace = ? AND (key LIKE ? OR content LIKE ?) ORDER BY updated_at DESC LIMIT ?'
      ).all(options.namespace, pattern, pattern, limit) as Row[];
      total = (this.db.prepare(
        'SELECT COUNT(*) as total FROM memories WHERE namespace = ? AND (key LIKE ? OR content LIKE ?)'
      ).get(options.namespace, pattern, pattern) as CountRow).total;
    } else {
      rows = this.db.prepare(
        'SELECT * FROM memories WHERE key LIKE ? OR content LIKE ? ORDER BY updated_at DESC LIMIT ?'
      ).all(pattern, pattern, limit) as Row[];
      total = (this.db.prepare(
        'SELECT COUNT(*) as total FROM memories WHERE key LIKE ? OR content LIKE ?'
      ).get(pattern, pattern) as CountRow).total;
    }

    return {
      memories: rows.map(rowToMemory),
      total,
    };
  }

  /**
   * Delete a memory by namespace and key.
   */
  delete(namespace: string, key: string): boolean {
    const result = this.db.prepare('DELETE FROM memories WHERE namespace = ? AND key = ?').run(namespace, key);
    return result.changes > 0;
  }

  /**
   * Delete all memories in a namespace.
   */
  clearNamespace(namespace: string): number {
    const result = this.db.prepare('DELETE FROM memories WHERE namespace = ?').run(namespace);
    return result.changes;
  }

  /**
   * List all distinct namespaces.
   */
  listNamespaces(): string[] {
    type Row = { namespace: string };
    const rows = this.db.prepare('SELECT DISTINCT namespace FROM memories ORDER BY namespace').all() as Row[];
    return rows.map((row) => row.namespace);
  }

  /**
   * Get the total count of memories.
   */
  count(namespace?: string): number {
    type CountRow = { total: number };
    if (namespace) {
      return (this.db.prepare('SELECT COUNT(*) as total FROM memories WHERE namespace = ?').get(namespace) as CountRow).total;
    }
    return (this.db.prepare('SELECT COUNT(*) as total FROM memories').get() as CountRow).total;
  }

  /**
   * Build a prompt-ready summary of recent memories for context injection.
   */
  buildContextSummary(options: { maxEntries?: number; maxChars?: number; namespace?: string } = {}): string {
    const maxEntries = options.maxEntries ?? 20;
    const maxChars = options.maxChars ?? 4000;
    const memories = this.list(options.namespace, maxEntries);

    if (memories.length === 0) {
      return '';
    }

    const lines: string[] = [];
    let totalChars = 0;

    for (const memory of memories) {
      const line = `- [${memory.namespace}/${memory.key}]: ${memory.content}`;
      if (totalChars + line.length > maxChars) {
        break;
      }
      lines.push(line);
      totalChars += line.length;
    }

    return lines.join('\n');
  }

  close(): void {
    this.db.close();
  }
}

function rowToMemory(row: {
  id: number;
  namespace: string;
  key: string;
  content: string;
  created_at: string;
  updated_at: string;
}): AgentMemory {
  return {
    id: row.id,
    namespace: row.namespace,
    key: row.key,
    content: row.content,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}
