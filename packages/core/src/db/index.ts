import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type { Message, MessageAttachment, Session, ToolResult } from '../types.js';

/**
 * SQLite Database for Keygate persistence
 */
export class KeygateDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const defaultPath = path.join(os.homedir(), '.config', 'keygate', 'keygate.db');
    const targetPath = dbPath ?? defaultPath;
    
    // Ensure directory exists
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    
    this.db = new Database(targetPath);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        channel_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_call_id TEXT,
        tool_calls TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS tool_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments TEXT NOT NULL,
        result TEXT NOT NULL,
        success INTEGER NOT NULL,
        security_mode TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_tool_logs_session ON tool_logs(session_id);
    `);

    this.ensureMessagesAttachmentsColumn();
  }

  private ensureMessagesAttachmentsColumn(): void {
    type ColumnInfo = {
      name: string;
    };

    const columns = this.db.prepare('PRAGMA table_info(messages)').all() as ColumnInfo[];
    const hasAttachmentsColumn = columns.some((column) => column.name === 'attachments');
    if (hasAttachmentsColumn) {
      return;
    }

    this.db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT');
  }

  /**
   * Save a session to the database
   */
  saveSession(session: Session): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, channel_type, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(
      session.id,
      session.channelType,
      session.createdAt.toISOString(),
      session.updatedAt.toISOString()
    );
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): Session | null {
    type SessionRow = {
      id: string;
      channel_type: 'web' | 'discord' | 'terminal';
      created_at: string;
      updated_at: string;
    };

    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const row = stmt.get(sessionId) as SessionRow | undefined;
    
    if (!row) return null;

    const messages = this.getMessages(sessionId);

    return {
      id: row.id,
      channelType: row.channel_type,
      messages,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  /**
   * List sessions sorted by most recently updated.
   */
  listSessions(limit = 200): Session[] {
    type SessionRow = {
      id: string;
      channel_type: 'web' | 'discord' | 'terminal';
      created_at: string;
      updated_at: string;
    };

    const stmt = this.db.prepare(`
      SELECT id, channel_type, created_at, updated_at
      FROM sessions
      ORDER BY updated_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as SessionRow[];

    return rows.map((row) => ({
      id: row.id,
      channelType: row.channel_type,
      messages: this.getMessages(row.id),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }));
  }

  /**
   * Save a message to the database
   */
  saveMessage(sessionId: string, message: Message): void {
    const stmt = this.db.prepare(`
      INSERT INTO messages (session_id, role, content, attachments, tool_call_id, tool_calls, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      sessionId,
      message.role,
      message.content,
      message.attachments ? JSON.stringify(message.attachments) : null,
      message.toolCallId ?? null,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      new Date().toISOString()
    );
  }

  /**
   * Get all messages for a session
   */
  getMessages(sessionId: string): Message[] {
    type MessageRow = {
      role: 'system' | 'user' | 'assistant' | 'tool';
      content: string;
      attachments: string | null;
      tool_call_id: string | null;
      tool_calls: string | null;
    };

    const stmt = this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC');
    const rows = stmt.all(sessionId) as MessageRow[];

    return rows.map(row => ({
      role: row.role,
      content: row.content,
      attachments: parseMessageAttachments(row.attachments),
      toolCallId: row.tool_call_id ?? undefined,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    }));
  }

  getSessionAttachmentPaths(sessionId: string): string[] {
    type AttachmentsRow = {
      attachments: string | null;
    };

    const stmt = this.db.prepare(`
      SELECT attachments
      FROM messages
      WHERE session_id = ?
        AND attachments IS NOT NULL
    `);

    const rows = stmt.all(sessionId) as AttachmentsRow[];
    const seen = new Set<string>();
    const paths: string[] = [];

    for (const row of rows) {
      const attachments = parseMessageAttachments(row.attachments);
      if (!attachments) {
        continue;
      }

      for (const attachment of attachments) {
        const normalizedPath = attachment.path.trim();
        if (!normalizedPath || seen.has(normalizedPath)) {
          continue;
        }

        seen.add(normalizedPath);
        paths.push(normalizedPath);
      }
    }

    return paths;
  }

  /**
   * Log a tool execution
   */
  logToolExecution(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
    securityMode: string
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO tool_logs (session_id, tool_name, arguments, result, success, security_mode, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      sessionId,
      toolName,
      JSON.stringify(args),
      JSON.stringify(result),
      result.success ? 1 : 0,
      securityMode,
      new Date().toISOString()
    );
  }

  /**
   * Get recent tool logs
   */
  getRecentToolLogs(limit = 50): Array<{
    sessionId: string;
    toolName: string;
    success: boolean;
    createdAt: Date;
  }> {
    type ToolLogRow = {
      session_id: string;
      tool_name: string;
      success: number;
      created_at: string;
    };

    const stmt = this.db.prepare(`
      SELECT session_id, tool_name, success, created_at 
      FROM tool_logs 
      ORDER BY id DESC 
      LIMIT ?
    `);
    const rows = stmt.all(limit) as ToolLogRow[];

    return rows.map(row => ({
      sessionId: row.session_id,
      toolName: row.tool_name,
      success: row.success === 1,
      createdAt: new Date(row.created_at),
    }));
  }

  /**
   * Clear all messages for a session
   */
  clearSession(sessionId: string): void {
    const stmt = this.db.prepare('DELETE FROM messages WHERE session_id = ?');
    stmt.run(sessionId);
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}

// Re-export as Database for simpler imports
export { KeygateDatabase as Database };

function parseMessageAttachments(value: string | null): MessageAttachment[] | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return undefined;
    }

    const attachments = parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') {
        return [];
      }

      const record = entry as Record<string, unknown>;
      const id = typeof record['id'] === 'string' ? record['id'].trim() : '';
      const filename = typeof record['filename'] === 'string' ? record['filename'].trim() : '';
      const contentType = typeof record['contentType'] === 'string' ? record['contentType'].trim() : '';
      const sizeBytes = Number.parseInt(String(record['sizeBytes'] ?? ''), 10);
      const filePath = typeof record['path'] === 'string' ? record['path'].trim() : '';
      const url = typeof record['url'] === 'string' ? record['url'].trim() : '';

      if (!id || !filename || !contentType || !Number.isFinite(sizeBytes) || sizeBytes < 0 || !filePath || !url) {
        return [];
      }

      return [{
        id,
        filename,
        contentType,
        sizeBytes,
        path: filePath,
        url,
      } satisfies MessageAttachment];
    });

    return attachments.length > 0 ? attachments : undefined;
  } catch {
    return undefined;
  }
}
