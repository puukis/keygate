import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  ChannelActionName,
  ChannelType,
  CodexReasoningEffort,
  LLMUsageSnapshot,
  Message,
  MessageAttachment,
  Session,
  SessionModelOverride,
  SessionUsageAggregate,
  ToolResult,
} from '../types.js';
import { getConfigDir } from '../config/env.js';

/**
 * SQLite Database for Keygate persistence
 */
export class KeygateDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const defaultPath = path.join(getConfigDir(), 'keygate.db');
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
        title TEXT DEFAULT '',
        model_override_provider TEXT,
        model_override_model TEXT,
        model_override_reasoning_effort TEXT,
        debug_mode INTEGER NOT NULL DEFAULT 0,
        compaction_summary_ref TEXT,
        usage_turn_count INTEGER NOT NULL DEFAULT 0,
        usage_input_tokens INTEGER NOT NULL DEFAULT 0,
        usage_output_tokens INTEGER NOT NULL DEFAULT 0,
        usage_cached_tokens INTEGER NOT NULL DEFAULT 0,
        usage_total_tokens INTEGER NOT NULL DEFAULT 0,
        usage_cost_usd REAL NOT NULL DEFAULT 0,
        usage_last_turn_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        attachments TEXT,
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

      CREATE TABLE IF NOT EXISTS message_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usage_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER,
        cost_usd REAL,
        estimated_cost INTEGER NOT NULL DEFAULT 0,
        source TEXT,
        raw TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS session_compactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_message_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS webchat_links (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS channel_actions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        action TEXT NOT NULL,
        account_id TEXT,
        external_message_id TEXT,
        thread_id TEXT,
        poll_id TEXT,
        ok INTEGER NOT NULL,
        payload TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS channel_polls (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        external_message_id TEXT,
        question TEXT NOT NULL,
        options TEXT NOT NULL,
        multiple INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS channel_poll_votes (
        id TEXT PRIMARY KEY,
        poll_id TEXT NOT NULL,
        voter_id TEXT NOT NULL,
        option_ids TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (poll_id) REFERENCES channel_polls(id)
      );

      CREATE TABLE IF NOT EXISTS canvas_surfaces (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        path TEXT NOT NULL,
        state TEXT,
        status_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS memory_migrations (
        id TEXT PRIMARY KEY,
        backend TEXT NOT NULL,
        phase TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        details TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_tool_logs_session ON tool_logs(session_id);
      CREATE INDEX IF NOT EXISTS idx_message_usage_session ON message_usage(session_id);
      CREATE INDEX IF NOT EXISTS idx_message_usage_created_at ON message_usage(created_at);
      CREATE INDEX IF NOT EXISTS idx_session_compactions_session ON session_compactions(session_id);
      CREATE INDEX IF NOT EXISTS idx_webchat_links_session ON webchat_links(session_id);
      CREATE INDEX IF NOT EXISTS idx_channel_actions_session ON channel_actions(session_id);
      CREATE INDEX IF NOT EXISTS idx_channel_polls_session ON channel_polls(session_id);
      CREATE INDEX IF NOT EXISTS idx_channel_poll_votes_poll ON channel_poll_votes(poll_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_surfaces_session_surface ON canvas_surfaces(session_id, surface_id);
      CREATE INDEX IF NOT EXISTS idx_memory_migrations_updated ON memory_migrations(updated_at);
    `);

    this.ensureMessagesAttachmentsColumn();
    this.ensureMessagesMetadataColumn();
    this.ensureSessionsColumns();
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

  private ensureMessagesMetadataColumn(): void {
    type ColumnInfo = {
      name: string;
    };

    const columns = this.db.prepare('PRAGMA table_info(messages)').all() as ColumnInfo[];
    const hasMetadataColumn = columns.some((column) => column.name === 'metadata');
    if (hasMetadataColumn) {
      return;
    }

    this.db.exec('ALTER TABLE messages ADD COLUMN metadata TEXT');
  }

  private ensureSessionsColumns(): void {
    type ColumnInfo = {
      name: string;
    };

    const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as ColumnInfo[];
    const addColumn = (name: string, sql: string) => {
      if (columns.some((column) => column.name === name)) {
        return;
      }

      this.db.exec(`ALTER TABLE sessions ADD COLUMN ${sql}`);
      columns.push({ name });
    };

    addColumn('title', "title TEXT DEFAULT ''");
    addColumn('model_override_provider', 'model_override_provider TEXT');
    addColumn('model_override_model', 'model_override_model TEXT');
    addColumn('model_override_reasoning_effort', 'model_override_reasoning_effort TEXT');
    addColumn('debug_mode', 'debug_mode INTEGER NOT NULL DEFAULT 0');
    addColumn('compaction_summary_ref', 'compaction_summary_ref TEXT');
    addColumn('usage_turn_count', 'usage_turn_count INTEGER NOT NULL DEFAULT 0');
    addColumn('usage_input_tokens', 'usage_input_tokens INTEGER NOT NULL DEFAULT 0');
    addColumn('usage_output_tokens', 'usage_output_tokens INTEGER NOT NULL DEFAULT 0');
    addColumn('usage_cached_tokens', 'usage_cached_tokens INTEGER NOT NULL DEFAULT 0');
    addColumn('usage_total_tokens', 'usage_total_tokens INTEGER NOT NULL DEFAULT 0');
    addColumn('usage_cost_usd', 'usage_cost_usd REAL NOT NULL DEFAULT 0');
    addColumn('usage_last_turn_at', 'usage_last_turn_at TEXT');
  }

  private buildSessionUsageAggregate(row: {
    usage_turn_count?: number | null;
    usage_input_tokens?: number | null;
    usage_output_tokens?: number | null;
    usage_cached_tokens?: number | null;
    usage_total_tokens?: number | null;
    usage_cost_usd?: number | null;
    usage_last_turn_at?: string | null;
  }): SessionUsageAggregate {
    return {
      turnCount: Math.max(0, row.usage_turn_count ?? 0),
      inputTokens: Math.max(0, row.usage_input_tokens ?? 0),
      outputTokens: Math.max(0, row.usage_output_tokens ?? 0),
      cachedTokens: Math.max(0, row.usage_cached_tokens ?? 0),
      totalTokens: Math.max(0, row.usage_total_tokens ?? 0),
      costUsd: Number(row.usage_cost_usd ?? 0),
      lastTurnAt: row.usage_last_turn_at ?? undefined,
    };
  }

  private buildSessionModelOverride(row: {
    model_override_provider?: string | null;
    model_override_model?: string | null;
    model_override_reasoning_effort?: string | null;
  }): SessionModelOverride | undefined {
    if (!row.model_override_provider || !row.model_override_model) {
      return undefined;
    }

    return {
      provider: row.model_override_provider as SessionModelOverride['provider'],
      model: row.model_override_model,
      reasoningEffort: (row.model_override_reasoning_effort ?? undefined) as CodexReasoningEffort | undefined,
    };
  }

  /**
   * Save a session to the database
   */
  saveSession(session: Session): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (
        id,
        channel_type,
        title,
        model_override_provider,
        model_override_model,
        model_override_reasoning_effort,
        debug_mode,
        compaction_summary_ref,
        usage_turn_count,
        usage_input_tokens,
        usage_output_tokens,
        usage_cached_tokens,
        usage_total_tokens,
        usage_cost_usd,
        usage_last_turn_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const usage = session.usage ?? {
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    };
    stmt.run(
      session.id,
      session.channelType,
      session.title ?? '',
      session.modelOverride?.provider ?? null,
      session.modelOverride?.model ?? null,
      session.modelOverride?.reasoningEffort ?? null,
      session.debugMode === true ? 1 : 0,
      session.compactionSummaryRef ?? null,
      usage.turnCount,
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedTokens,
      usage.totalTokens,
      usage.costUsd,
      usage.lastTurnAt ?? null,
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
      channel_type: ChannelType;
      title: string | null;
      model_override_provider: string | null;
      model_override_model: string | null;
      model_override_reasoning_effort: string | null;
      debug_mode: number;
      compaction_summary_ref: string | null;
      usage_turn_count: number;
      usage_input_tokens: number;
      usage_output_tokens: number;
      usage_cached_tokens: number;
      usage_total_tokens: number;
      usage_cost_usd: number;
      usage_last_turn_at: string | null;
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
      title: row.title || undefined,
      messages,
      modelOverride: this.buildSessionModelOverride(row),
      debugMode: row.debug_mode === 1,
      compactionSummaryRef: row.compaction_summary_ref ?? undefined,
      usage: this.buildSessionUsageAggregate(row),
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
      channel_type: ChannelType;
      title: string | null;
      model_override_provider: string | null;
      model_override_model: string | null;
      model_override_reasoning_effort: string | null;
      debug_mode: number;
      compaction_summary_ref: string | null;
      usage_turn_count: number;
      usage_input_tokens: number;
      usage_output_tokens: number;
      usage_cached_tokens: number;
      usage_total_tokens: number;
      usage_cost_usd: number;
      usage_last_turn_at: string | null;
      created_at: string;
      updated_at: string;
    };

    const stmt = this.db.prepare(`
      SELECT
        id,
        channel_type,
        title,
        model_override_provider,
        model_override_model,
        model_override_reasoning_effort,
        debug_mode,
        compaction_summary_ref,
        usage_turn_count,
        usage_input_tokens,
        usage_output_tokens,
        usage_cached_tokens,
        usage_total_tokens,
        usage_cost_usd,
        usage_last_turn_at,
        created_at,
        updated_at
      FROM sessions
      ORDER BY updated_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as SessionRow[];

    return rows.map((row) => ({
      id: row.id,
      channelType: row.channel_type,
      title: row.title || undefined,
      messages: this.getMessages(row.id),
      modelOverride: this.buildSessionModelOverride(row),
      debugMode: row.debug_mode === 1,
      compactionSummaryRef: row.compaction_summary_ref ?? undefined,
      usage: this.buildSessionUsageAggregate(row),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }));
  }

  /**
   * Save a message to the database
   */
  saveMessage(sessionId: string, message: Message): void {
    const stmt = this.db.prepare(`
      INSERT INTO messages (session_id, role, content, metadata, attachments, tool_call_id, tool_calls, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      sessionId,
      message.role,
      message.content,
      message.metadata ? JSON.stringify(message.metadata) : null,
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
      metadata: string | null;
      attachments: string | null;
      tool_call_id: string | null;
      tool_calls: string | null;
    };

    const stmt = this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC');
    const rows = stmt.all(sessionId) as MessageRow[];

    return rows.map(row => ({
      role: row.role,
      content: row.content,
      metadata: parseJsonRecord(row.metadata),
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
   * Update a session's title
   */
  updateSessionTitle(sessionId: string, title: string): void {
    const stmt = this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?');
    stmt.run(title, sessionId);
  }

  updateSessionState(sessionId: string, patch: {
    modelOverride?: SessionModelOverride | null;
    debugMode?: boolean;
    compactionSummaryRef?: string | null;
  }): void {
    const session = this.getSession(sessionId);
    if (!session) {
      return;
    }

    session.modelOverride = patch.modelOverride === undefined ? session.modelOverride : patch.modelOverride ?? undefined;
    session.debugMode = patch.debugMode === undefined ? session.debugMode : patch.debugMode;
    session.compactionSummaryRef = patch.compactionSummaryRef === undefined
      ? session.compactionSummaryRef
      : patch.compactionSummaryRef ?? undefined;
    this.saveSession(session);
  }

  recordMessageUsage(sessionId: string, usage: LLMUsageSnapshot, createdAt = new Date()): SessionUsageAggregate {
    const usageId = randomUUID();
    const timestamp = createdAt.toISOString();
    const normalized: SessionUsageAggregate = {
      turnCount: 1,
      inputTokens: Math.max(0, usage.inputTokens),
      outputTokens: Math.max(0, usage.outputTokens),
      cachedTokens: Math.max(0, usage.cachedTokens),
      totalTokens: Math.max(0, usage.totalTokens),
      costUsd: Number(usage.costUsd ?? 0),
      lastTurnAt: timestamp,
    };

    this.db.prepare(`
      INSERT INTO message_usage (
        usage_id,
        session_id,
        provider,
        model,
        input_tokens,
        output_tokens,
        cached_tokens,
        total_tokens,
        latency_ms,
        cost_usd,
        estimated_cost,
        source,
        raw,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      usageId,
      sessionId,
      usage.provider,
      usage.model,
      normalized.inputTokens,
      normalized.outputTokens,
      normalized.cachedTokens,
      normalized.totalTokens,
      usage.latencyMs ?? null,
      usage.costUsd ?? null,
      usage.estimatedCost === true ? 1 : 0,
      usage.source ?? null,
      usage.raw ? JSON.stringify(usage.raw) : null,
      timestamp,
    );

    this.db.prepare(`
      UPDATE sessions
      SET
        usage_turn_count = COALESCE(usage_turn_count, 0) + 1,
        usage_input_tokens = COALESCE(usage_input_tokens, 0) + ?,
        usage_output_tokens = COALESCE(usage_output_tokens, 0) + ?,
        usage_cached_tokens = COALESCE(usage_cached_tokens, 0) + ?,
        usage_total_tokens = COALESCE(usage_total_tokens, 0) + ?,
        usage_cost_usd = COALESCE(usage_cost_usd, 0) + ?,
        usage_last_turn_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      normalized.inputTokens,
      normalized.outputTokens,
      normalized.cachedTokens,
      normalized.totalTokens,
      normalized.costUsd,
      normalized.lastTurnAt,
      timestamp,
      sessionId,
    );

    return this.getSessionUsageAggregate(sessionId);
  }

  getSessionUsageAggregate(sessionId: string): SessionUsageAggregate {
    type UsageRow = {
      usage_turn_count: number | null;
      usage_input_tokens: number | null;
      usage_output_tokens: number | null;
      usage_cached_tokens: number | null;
      usage_total_tokens: number | null;
      usage_cost_usd: number | null;
      usage_last_turn_at: string | null;
    };

    const row = this.db.prepare(`
      SELECT
        usage_turn_count,
        usage_input_tokens,
        usage_output_tokens,
        usage_cached_tokens,
        usage_total_tokens,
        usage_cost_usd,
        usage_last_turn_at
      FROM sessions
      WHERE id = ?
    `).get(sessionId) as UsageRow | undefined;

    return this.buildSessionUsageAggregate(row ?? {});
  }

  listMessageUsage(options: { sessionId?: string; createdAfter?: string } = {}): Array<{
    usageId: string;
    sessionId: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    totalTokens: number;
    latencyMs?: number;
    costUsd?: number;
    estimatedCost: boolean;
    source?: string;
    raw?: Record<string, unknown>;
    createdAt: string;
  }> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.sessionId) {
      where.push('session_id = ?');
      params.push(options.sessionId);
    }
    if (options.createdAfter) {
      where.push('created_at >= ?');
      params.push(options.createdAfter);
    }

    const rows = this.db.prepare(`
      SELECT
        usage_id,
        session_id,
        provider,
        model,
        input_tokens,
        output_tokens,
        cached_tokens,
        total_tokens,
        latency_ms,
        cost_usd,
        estimated_cost,
        source,
        raw,
        created_at
      FROM message_usage
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
    `).all(...params) as Array<{
      usage_id: string;
      session_id: string;
      provider: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
      total_tokens: number;
      latency_ms: number | null;
      cost_usd: number | null;
      estimated_cost: number;
      source: string | null;
      raw: string | null;
      created_at: string;
    }>;

    return rows.map((row) => ({
      usageId: row.usage_id,
      sessionId: row.session_id,
      provider: row.provider,
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cachedTokens: row.cached_tokens,
      totalTokens: row.total_tokens,
      latencyMs: row.latency_ms ?? undefined,
      costUsd: row.cost_usd ?? undefined,
      estimatedCost: row.estimated_cost === 1,
      source: row.source ?? undefined,
      raw: parseJsonRecord(row.raw),
      createdAt: row.created_at,
    }));
  }

  saveSessionCompaction(sessionId: string, summary: string, sourceMessageCount: number): string {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO session_compactions (id, session_id, summary, source_message_count, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, sessionId, summary, sourceMessageCount, createdAt);
    this.db.prepare(`
      UPDATE sessions
      SET compaction_summary_ref = ?, updated_at = ?
      WHERE id = ?
    `).run(id, createdAt, sessionId);
    return id;
  }

  getSessionCompaction(compactionId: string): {
    id: string;
    sessionId: string;
    summary: string;
    sourceMessageCount: number;
    createdAt: string;
  } | null {
    const row = this.db.prepare(`
      SELECT id, session_id, summary, source_message_count, created_at
      FROM session_compactions
      WHERE id = ?
    `).get(compactionId) as {
      id: string;
      session_id: string;
      summary: string;
      source_message_count: number;
      created_at: string;
    } | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      sessionId: row.session_id,
      summary: row.summary,
      sourceMessageCount: row.source_message_count,
      createdAt: row.created_at,
    };
  }

  createWebChatLink(params: {
    id?: string;
    sessionId: string;
    displayName: string;
    tokenHash: string;
    capabilities: Record<string, unknown>;
    expiresAt: string;
    createdBy?: string;
  }): {
    id: string;
    sessionId: string;
    displayName: string;
    tokenHash: string;
    capabilities: Record<string, unknown>;
    expiresAt: string;
    revokedAt?: string;
    createdBy: string;
    createdAt: string;
  } {
    const id = params.id ?? randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO webchat_links (
        id, session_id, display_name, token_hash, capabilities, expires_at, revoked_at, created_by, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      id,
      params.sessionId,
      params.displayName,
      params.tokenHash,
      JSON.stringify(params.capabilities ?? {}),
      params.expiresAt,
      params.createdBy ?? 'operator',
      createdAt,
    );

    return {
      id,
      sessionId: params.sessionId,
      displayName: params.displayName,
      tokenHash: params.tokenHash,
      capabilities: params.capabilities ?? {},
      expiresAt: params.expiresAt,
      createdBy: params.createdBy ?? 'operator',
      createdAt,
    };
  }

  listWebChatLinks(sessionId?: string): Array<{
    id: string;
    sessionId: string;
    displayName: string;
    tokenHash: string;
    capabilities: Record<string, unknown>;
    expiresAt: string;
    revokedAt?: string;
    createdBy: string;
    createdAt: string;
  }> {
    const rows = (sessionId
      ? this.db.prepare(`
          SELECT id, session_id, display_name, token_hash, capabilities, expires_at, revoked_at, created_by, created_at
          FROM webchat_links
          WHERE session_id = ?
          ORDER BY created_at DESC
        `).all(sessionId)
      : this.db.prepare(`
          SELECT id, session_id, display_name, token_hash, capabilities, expires_at, revoked_at, created_by, created_at
          FROM webchat_links
          ORDER BY created_at DESC
        `).all()) as Array<{
      id: string;
      session_id: string;
      display_name: string;
      token_hash: string;
      capabilities: string;
      expires_at: string;
      revoked_at: string | null;
      created_by: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      displayName: row.display_name,
      tokenHash: row.token_hash,
      capabilities: parseJsonRecord(row.capabilities) ?? {},
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at ?? undefined,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }));
  }

  getWebChatLink(linkId: string): {
    id: string;
    sessionId: string;
    displayName: string;
    tokenHash: string;
    capabilities: Record<string, unknown>;
    expiresAt: string;
    revokedAt?: string;
    createdBy: string;
    createdAt: string;
  } | null {
    const row = this.db.prepare(`
      SELECT id, session_id, display_name, token_hash, capabilities, expires_at, revoked_at, created_by, created_at
      FROM webchat_links
      WHERE id = ?
    `).get(linkId) as {
      id: string;
      session_id: string;
      display_name: string;
      token_hash: string;
      capabilities: string;
      expires_at: string;
      revoked_at: string | null;
      created_by: string;
      created_at: string;
    } | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      sessionId: row.session_id,
      displayName: row.display_name,
      tokenHash: row.token_hash,
      capabilities: parseJsonRecord(row.capabilities) ?? {},
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at ?? undefined,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  revokeWebChatLink(linkId: string): boolean {
    const result = this.db.prepare(`
      UPDATE webchat_links
      SET revoked_at = COALESCE(revoked_at, ?)
      WHERE id = ?
    `).run(new Date().toISOString(), linkId);
    return result.changes > 0;
  }

  saveChannelAction(params: {
    sessionId: string;
    channel: ChannelType | 'webchat';
    action: ChannelActionName;
    accountId?: string | null;
    externalMessageId?: string | null;
    threadId?: string | null;
    pollId?: string | null;
    ok: boolean;
    payload?: Record<string, unknown>;
    error?: string | null;
  }): {
    id: string;
    createdAt: string;
  } {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO channel_actions (
        id, session_id, channel, action, account_id, external_message_id, thread_id, poll_id, ok, payload, error, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.sessionId,
      params.channel,
      params.action,
      params.accountId ?? null,
      params.externalMessageId ?? null,
      params.threadId ?? null,
      params.pollId ?? null,
      params.ok ? 1 : 0,
      params.payload ? JSON.stringify(params.payload) : null,
      params.error ?? null,
      createdAt,
    );
    return { id, createdAt };
  }

  listChannelActions(sessionId: string, limit = 100): Array<{
    id: string;
    sessionId: string;
    channel: string;
    action: string;
    accountId?: string;
    externalMessageId?: string;
    threadId?: string;
    pollId?: string;
    ok: boolean;
    payload?: Record<string, unknown>;
    error?: string;
    createdAt: string;
  }> {
    const rows = this.db.prepare(`
      SELECT id, session_id, channel, action, account_id, external_message_id, thread_id, poll_id, ok, payload, error, created_at
      FROM channel_actions
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(sessionId, limit) as Array<{
      id: string;
      session_id: string;
      channel: string;
      action: string;
      account_id: string | null;
      external_message_id: string | null;
      thread_id: string | null;
      poll_id: string | null;
      ok: number;
      payload: string | null;
      error: string | null;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      channel: row.channel,
      action: row.action,
      accountId: row.account_id ?? undefined,
      externalMessageId: row.external_message_id ?? undefined,
      threadId: row.thread_id ?? undefined,
      pollId: row.poll_id ?? undefined,
      ok: row.ok === 1,
      payload: parseJsonRecord(row.payload),
      error: row.error ?? undefined,
      createdAt: row.created_at,
    }));
  }

  createChannelPoll(params: {
    sessionId: string;
    channel: ChannelType | 'webchat';
    externalMessageId?: string | null;
    question: string;
    options: string[];
    multiple?: boolean;
    metadata?: Record<string, unknown>;
  }): {
    id: string;
    createdAt: string;
    updatedAt: string;
  } {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO channel_polls (
        id, session_id, channel, external_message_id, question, options, multiple, status, metadata, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
    `).run(
      id,
      params.sessionId,
      params.channel,
      params.externalMessageId ?? null,
      params.question,
      JSON.stringify(params.options),
      params.multiple === true ? 1 : 0,
      params.metadata ? JSON.stringify(params.metadata) : null,
      now,
      now,
    );
    return { id, createdAt: now, updatedAt: now };
  }

  voteChannelPoll(params: {
    pollId: string;
    voterId: string;
    optionIds: string[];
  }): { voterId: string; optionIds: string[] } {
    const existing = this.db.prepare(`
      SELECT id FROM channel_poll_votes WHERE poll_id = ? AND voter_id = ?
    `).get(params.pollId, params.voterId) as { id: string } | undefined;
    const now = new Date().toISOString();
    if (existing) {
      this.db.prepare(`
        UPDATE channel_poll_votes
        SET option_ids = ?, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(params.optionIds), now, existing.id);
      return {
        voterId: params.voterId,
        optionIds: [...params.optionIds],
      };
    }

    this.db.prepare(`
      INSERT INTO channel_poll_votes (id, poll_id, voter_id, option_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), params.pollId, params.voterId, JSON.stringify(params.optionIds), now, now);
    return {
      voterId: params.voterId,
      optionIds: [...params.optionIds],
    };
  }

  listChannelPolls(sessionId: string): Array<{
    id: string;
    sessionId: string;
    channel: string;
    externalMessageId?: string;
    question: string;
    options: string[];
    multiple: boolean;
    status: string;
    metadata?: Record<string, unknown>;
    votes: Array<{ voterId: string; optionIds: string[] }>;
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = this.db.prepare(`
      SELECT id, session_id, channel, external_message_id, question, options, multiple, status, metadata, created_at, updated_at
      FROM channel_polls
      WHERE session_id = ?
      ORDER BY created_at DESC
    `).all(sessionId) as Array<{
      id: string;
      session_id: string;
      channel: string;
      external_message_id: string | null;
      question: string;
      options: string;
      multiple: number;
      status: string;
      metadata: string | null;
      created_at: string;
      updated_at: string;
    }>;

    const voteRows = this.db.prepare(`
      SELECT poll_id, voter_id, option_ids
      FROM channel_poll_votes
      WHERE poll_id IN (SELECT id FROM channel_polls WHERE session_id = ?)
    `).all(sessionId) as Array<{
      poll_id: string;
      voter_id: string;
      option_ids: string;
    }>;
    const votesByPoll = new Map<string, Array<{ voterId: string; optionIds: string[] }>>();
    for (const vote of voteRows) {
      const bucket = votesByPoll.get(vote.poll_id) ?? [];
      bucket.push({
        voterId: vote.voter_id,
        optionIds: parseJsonArray(vote.option_ids).flatMap((entry) => typeof entry === 'string' ? [entry] : []),
      });
      votesByPoll.set(vote.poll_id, bucket);
    }

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      channel: row.channel,
      externalMessageId: row.external_message_id ?? undefined,
      question: row.question,
      options: parseJsonArray(row.options).flatMap((entry) => typeof entry === 'string' ? [entry] : []),
      multiple: row.multiple === 1,
      status: row.status,
      metadata: parseJsonRecord(row.metadata),
      votes: votesByPoll.get(row.id) ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  upsertCanvasSurface(params: {
    sessionId: string;
    surfaceId: string;
    path: string;
    state?: Record<string, unknown>;
    statusText?: string;
  }): {
    id: string;
    createdAt: string;
    updatedAt: string;
  } {
    const existing = this.db.prepare(`
      SELECT id, created_at FROM canvas_surfaces WHERE session_id = ? AND surface_id = ?
    `).get(params.sessionId, params.surfaceId) as { id: string; created_at: string } | undefined;
    const id = existing?.id ?? randomUUID();
    const createdAt = existing?.created_at ?? new Date().toISOString();
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO canvas_surfaces (id, session_id, surface_id, path, state, status_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, surface_id) DO UPDATE SET
        path = excluded.path,
        state = excluded.state,
        status_text = excluded.status_text,
        updated_at = excluded.updated_at
    `).run(
      id,
      params.sessionId,
      params.surfaceId,
      params.path,
      params.state ? JSON.stringify(params.state) : null,
      params.statusText ?? null,
      createdAt,
      updatedAt,
    );
    return { id, createdAt, updatedAt };
  }

  getCanvasSurface(sessionId: string, surfaceId: string): {
    id: string;
    sessionId: string;
    surfaceId: string;
    path: string;
    state?: Record<string, unknown>;
    statusText?: string;
    createdAt: string;
    updatedAt: string;
  } | null {
    const row = this.db.prepare(`
      SELECT id, session_id, surface_id, path, state, status_text, created_at, updated_at
      FROM canvas_surfaces
      WHERE session_id = ? AND surface_id = ?
    `).get(sessionId, surfaceId) as {
      id: string;
      session_id: string;
      surface_id: string;
      path: string;
      state: string | null;
      status_text: string | null;
      created_at: string;
      updated_at: string;
    } | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      sessionId: row.session_id,
      surfaceId: row.surface_id,
      path: row.path,
      state: parseJsonRecord(row.state),
      statusText: row.status_text ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  deleteCanvasSurface(sessionId: string, surfaceId: string): boolean {
    return this.db.prepare(`
      DELETE FROM canvas_surfaces WHERE session_id = ? AND surface_id = ?
    `).run(sessionId, surfaceId).changes > 0;
  }

  createMemoryMigration(params: {
    backend: 'sqlite-vec' | 'lancedb';
    phase: string;
    progress?: number;
    status?: string;
    details?: Record<string, unknown>;
  }): {
    id: string;
    createdAt: string;
    updatedAt: string;
  } {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO memory_migrations (id, backend, phase, progress, status, details, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.backend,
      params.phase,
      params.progress ?? 0,
      params.status ?? 'pending',
      params.details ? JSON.stringify(params.details) : null,
      now,
      now,
    );
    return { id, createdAt: now, updatedAt: now };
  }

  updateMemoryMigration(id: string, patch: {
    phase?: string;
    progress?: number;
    status?: string;
    details?: Record<string, unknown>;
  }): boolean {
    const row = this.db.prepare(`
      SELECT phase, progress, status, details
      FROM memory_migrations
      WHERE id = ?
    `).get(id) as {
      phase: string;
      progress: number;
      status: string;
      details: string | null;
    } | undefined;
    if (!row) {
      return false;
    }

    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE memory_migrations
      SET phase = ?, progress = ?, status = ?, details = ?, updated_at = ?
      WHERE id = ?
    `).run(
      patch.phase ?? row.phase,
      patch.progress ?? row.progress,
      patch.status ?? row.status,
      patch.details ? JSON.stringify(patch.details) : row.details,
      updatedAt,
      id,
    );
    return true;
  }

  getLatestMemoryMigration(): {
    id: string;
    backend: 'sqlite-vec' | 'lancedb';
    phase: string;
    progress: number;
    status: string;
    details?: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  } | null {
    const row = this.db.prepare(`
      SELECT id, backend, phase, progress, status, details, created_at, updated_at
      FROM memory_migrations
      ORDER BY updated_at DESC
      LIMIT 1
    `).get() as {
      id: string;
      backend: 'sqlite-vec' | 'lancedb';
      phase: string;
      progress: number;
      status: string;
      details: string | null;
      created_at: string;
      updated_at: string;
    } | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      backend: row.backend,
      phase: row.phase,
      progress: row.progress,
      status: row.status,
      details: parseJsonRecord(row.details),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Clear all messages for a session
   */
  clearSession(sessionId: string): void {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM message_usage WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM session_compactions WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM channel_actions WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM channel_poll_votes WHERE poll_id IN (SELECT id FROM channel_polls WHERE session_id = ?)').run(sessionId);
    this.db.prepare('DELETE FROM channel_polls WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM canvas_surfaces WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM webchat_links WHERE session_id = ?').run(sessionId);
    this.db.prepare(`
      UPDATE sessions
      SET
        compaction_summary_ref = NULL,
        usage_turn_count = 0,
        usage_input_tokens = 0,
        usage_output_tokens = 0,
        usage_cached_tokens = 0,
        usage_total_tokens = 0,
        usage_cost_usd = 0,
        usage_last_turn_at = NULL
      WHERE id = ?
    `).run(sessionId);
  }

  /**
   * Delete a session and all its messages
   */
  deleteSession(sessionId: string): void {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM tool_logs WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM message_usage WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM session_compactions WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM channel_actions WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM channel_poll_votes WHERE poll_id IN (SELECT id FROM channel_polls WHERE session_id = ?)').run(sessionId);
    this.db.prepare('DELETE FROM channel_polls WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM canvas_surfaces WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM webchat_links WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
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
      const kind = typeof record['kind'] === 'string' ? record['kind'].trim() : undefined;
      const sha256 = typeof record['sha256'] === 'string' ? record['sha256'].trim() : undefined;
      const durationMs = parseNumberField(record['durationMs']);
      const width = parseNumberField(record['width']);
      const height = parseNumberField(record['height']);
      const pageCount = parseNumberField(record['pageCount']);
      const derivedFromId = typeof record['derivedFromId'] === 'string' ? record['derivedFromId'].trim() : undefined;
      const previewText = typeof record['previewText'] === 'string' ? record['previewText'] : undefined;
      const metadata = record['metadata'] && typeof record['metadata'] === 'object' && !Array.isArray(record['metadata'])
        ? record['metadata'] as Record<string, unknown>
        : undefined;

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
        kind: kind as MessageAttachment['kind'],
        sha256,
        durationMs,
        width,
        height,
        pageCount,
        derivedFromId,
        previewText,
        metadata,
      } satisfies MessageAttachment];
    });

    return attachments.length > 0 ? attachments : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonRecord(value: string | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function parseJsonArray(value: string | null): unknown[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseNumberField(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
