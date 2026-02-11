import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import BetterSqlite from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { Database } from '../index.js';

function sessionFixture() {
  return {
    id: 'web:test',
    channelType: 'web' as const,
    messages: [],
    createdAt: new Date('2026-02-11T10:00:00.000Z'),
    updatedAt: new Date('2026-02-11T10:00:00.000Z'),
  };
}

describe('Database attachments migration', () => {
  it('adds messages.attachments column when missing', async () => {
    const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-db-migration-'));
    const dbPath = path.join(dbDir, 'keygate.db');

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
    seed.close();

    const db = new Database(dbPath);
    db.close();

    const verify = new BetterSqlite(dbPath);
    const columns = verify.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    verify.close();

    expect(columns.some((column) => column.name === 'attachments')).toBe(true);
  });

  it('round-trips message attachments JSON', async () => {
    const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-db-roundtrip-'));
    const dbPath = path.join(dbDir, 'keygate.db');
    const db = new Database(dbPath);

    const session = sessionFixture();
    db.saveSession(session);
    db.saveMessage(session.id, {
      role: 'user',
      content: 'analyze image',
      attachments: [{
        id: 'att-1',
        filename: 'photo.png',
        contentType: 'image/png',
        sizeBytes: 1234,
        path: '/tmp/photo.png',
        url: '/api/uploads/image?sessionId=web%3Atest&id=att-1',
      }],
    });

    const messages = db.getMessages(session.id);
    db.close();

    expect(messages).toHaveLength(1);
    expect(messages[0]?.attachments).toEqual([{
      id: 'att-1',
      filename: 'photo.png',
      contentType: 'image/png',
      sizeBytes: 1234,
      path: '/tmp/photo.png',
      url: '/api/uploads/image?sessionId=web%3Atest&id=att-1',
    }]);
  });

  it('returns undefined attachments when stored JSON is invalid', async () => {
    const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-db-invalid-json-'));
    const dbPath = path.join(dbDir, 'keygate.db');

    const db = new Database(dbPath);
    const session = sessionFixture();
    db.saveSession(session);
    db.close();

    const raw = new BetterSqlite(dbPath);
    raw.prepare(`
      INSERT INTO messages (session_id, role, content, attachments, tool_call_id, tool_calls, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      'user',
      'broken',
      '{not-json}',
      null,
      null,
      new Date('2026-02-11T10:00:01.000Z').toISOString()
    );
    raw.close();

    const reopened = new Database(dbPath);
    const messages = reopened.getMessages(session.id);
    reopened.close();

    expect(messages[0]?.attachments).toBeUndefined();
  });
});
