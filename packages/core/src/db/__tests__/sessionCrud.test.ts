import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Database } from '../index.js';

function sessionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'web:test',
    channelType: 'web' as const,
    messages: [],
    createdAt: new Date('2026-02-11T10:00:00.000Z'),
    updatedAt: new Date('2026-02-11T10:00:00.000Z'),
    ...overrides,
  };
}

async function createDb() {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-db-crud-'));
  const dbPath = path.join(dbDir, 'keygate.db');
  return new Database(dbPath);
}

describe('Database session title', () => {
  it('persists and retrieves session title', async () => {
    const db = await createDb();
    const session = sessionFixture({ title: 'My important chat' });
    db.saveSession(session);

    const retrieved = db.getSession('web:test');
    db.close();

    expect(retrieved).not.toBeNull();
    expect(retrieved?.title).toBe('My important chat');
  });

  it('returns undefined title when field is empty', async () => {
    const db = await createDb();
    const session = sessionFixture();
    db.saveSession(session);

    const retrieved = db.getSession('web:test');
    db.close();

    expect(retrieved?.title).toBeUndefined();
  });

  it('updates session title via updateSessionTitle', async () => {
    const db = await createDb();
    db.saveSession(sessionFixture());

    db.updateSessionTitle('web:test', 'Renamed session');
    const retrieved = db.getSession('web:test');
    db.close();

    expect(retrieved?.title).toBe('Renamed session');
  });

  it('lists sessions with their titles', async () => {
    const db = await createDb();
    db.saveSession(sessionFixture({ id: 'web:a', title: 'Alpha' }));
    db.saveSession(sessionFixture({ id: 'web:b', title: 'Beta' }));

    const sessions = db.listSessions();
    db.close();

    const titles = sessions.map((s) => s.title);
    expect(titles).toContain('Alpha');
    expect(titles).toContain('Beta');
  });
});

describe('Database deleteSession', () => {
  it('removes session, messages, and tool_logs', async () => {
    const db = await createDb();
    const session = sessionFixture();
    db.saveSession(session);
    db.saveMessage('web:test', { role: 'user', content: 'hello' });
    db.saveMessage('web:test', { role: 'assistant', content: 'hi there' });

    db.deleteSession('web:test');

    expect(db.getSession('web:test')).toBeNull();
    expect(db.getMessages('web:test')).toHaveLength(0);
    db.close();
  });

  it('does not throw when deleting non-existent session', async () => {
    const db = await createDb();
    expect(() => db.deleteSession('web:nonexistent')).not.toThrow();
    db.close();
  });
});

describe('Database title migration', () => {
  it('adds title column to legacy database schema', async () => {
    const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-db-title-migration-'));
    const dbPath = path.join(dbDir, 'keygate.db');

    // Create a DB with old schema (no title column)
    const { default: BetterSqlite } = await import('better-sqlite3');
    const seed = new BetterSqlite(dbPath);
    seed.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        channel_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        attachments TEXT,
        tool_call_id TEXT,
        tool_calls TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE TABLE tool_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments TEXT NOT NULL,
        result TEXT NOT NULL,
        success INTEGER NOT NULL,
        security_mode TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    // Insert a session without title column
    seed.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(
      'web:legacy',
      'web',
      new Date().toISOString(),
      new Date().toISOString()
    );
    seed.close();

    // Open with our Database class — migration should run
    const db = new Database(dbPath);
    const session = db.getSession('web:legacy');
    db.close();

    expect(session).not.toBeNull();
    expect(session?.title).toBeUndefined(); // empty string becomes undefined
  });
});
