import { EventEmitter } from 'eventemitter3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type {
  CodexReasoningEffort,
  KeygateConfig,
  KeygateEvents,
  LLMUsageSnapshot,
  NormalizedMessage,
  ProviderModelOption,
  SecurityMode,
  SessionDebugEvent,
  SessionModelOverride,
  SessionCancelReason,
  Session,
  SessionUsageAggregate,
  ToolExecutionContext,
  Channel,
} from '../types.js';
import { LaneQueue } from './LaneQueue.js';
import { CommandRouter } from './CommandRouter.js';
import { Brain } from '../brain/Brain.js';
import { formatCapabilitiesAndLimitsForReadability } from '../brain/assistantOutputFormatter.js';
import { ToolExecutor } from '../tools/ToolExecutor.js';
import { Database } from '../db/index.js';
import { AgentMemoryStore } from '../db/agentMemory.js';
import { MemoryManager } from '../memory/manager.js';
import type { MemoryConfig } from '../memory/embedding/types.js';
import { createLLMProvider } from '../llm/index.js';
import { UsageService } from '../usage/index.js';
import { SandboxManager } from '../sandbox/index.js';
import { SkillsManager } from '../skills/index.js';
import { PluginRuntimeManager } from '../plugins/index.js';
import { allBuiltinTools } from '../tools/builtin/index.js';
import { GitService } from '../git/index.js';
import { SchedulerService, SchedulerStore, type ScheduledJob, type ScheduledJobCreateInput, type ScheduledJobUpdateInput } from '../scheduler/index.js';
import { ensureWorkspaceGitRepo } from '../workspace/gitWorkspace.js';

const CANCEL_HARD_STOP_TIMEOUT_MS = 2_000;
const MAX_DEBUG_EVENTS_PER_SESSION = 200;

interface ActiveSessionRun {
  sessionId: string;
  controller: AbortController;
  abortCleanups: Set<() => void | Promise<void>>;
  hardStopTimer: NodeJS.Timeout | null;
  cancelledReason: SessionCancelReason | null;
}

export interface DelegatedSessionRecord {
  sessionId: string;
  parentSessionId: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  status: 'idle' | 'running' | 'cancelled';
}

/**
 * Gateway - The central hub of Keygate
 * 
 * Singleton managing:
 * - Session state
 * - Lane queues for serial per-session processing
 * - Security mode switching
 * - Event emission for UI updates
 */
export class Gateway extends EventEmitter<KeygateEvents> {
  private static instance: Gateway | null = null;

  private sessions = new Map<string, Session>();
  private laneQueues = new Map<string, LaneQueue>();
  private activeRuns = new Map<string, ActiveSessionRun>();
  private delegatedSessions = new Map<string, DelegatedSessionRecord>();
  private proactiveSenders = new Map<string, (sessionId: string, content: string) => Promise<void>>();
  private sessionWorkspacePaths = new Map<string, string>();
  private sessionDebugEvents = new Map<string, SessionDebugEvent[]>();
  private securityMode: SecurityMode = 'safe';

  public readonly brain: Brain;
  public readonly commandRouter: CommandRouter;
  public readonly toolExecutor: ToolExecutor;
  public readonly db: Database;
  public readonly memory: AgentMemoryStore;
  public readonly config: KeygateConfig;
  public readonly skills: SkillsManager;
  public readonly plugins: PluginRuntimeManager;
  public readonly schedulerStore: SchedulerStore;
  public readonly schedulerService: SchedulerService;
  public readonly memoryManager: MemoryManager;
  public readonly git: GitService;
  public readonly usage: UsageService;
  public readonly sandbox: SandboxManager;

  private constructor(config: KeygateConfig) {
    super();
    this.config = config;
    this.securityMode = config.security.mode;
    if (!this.config.security.spicyModeEnabled) {
      this.config.security.spicyMaxObedienceEnabled = false;
    }

    // Initialize database
    this.db = new Database();
    this.memory = new AgentMemoryStore();
    this.sandbox = new SandboxManager(config);

    // Initialize tool executor with security settings
    this.toolExecutor = new ToolExecutor(
      this.securityMode,
      config.security.workspacePath,
      config.security.allowedBinaries,
      this
    );

    // Register all built-in tools
    for (const tool of allBuiltinTools) {
      this.toolExecutor.registerTool(tool);
    }

    // Initialize vector memory manager
    const memoryConfig: MemoryConfig = config.memory ?? {
      provider: 'auto',
      vectorWeight: 0.7,
      textWeight: 0.3,
      maxResults: 6,
      minScore: 0.35,
      autoIndex: true,
      indexSessions: true,
      temporalDecay: false,
      temporalHalfLifeDays: 30,
      mmr: false,
    };
    this.memoryManager = new MemoryManager(config, memoryConfig);

    // Initialize git service
    this.git = new GitService();
    this.usage = new UsageService(this.db, config);

    // Initialize brain with LLM provider
    this.brain = new Brain(config, this.toolExecutor, this, this.memory, this.memoryManager);
    this.commandRouter = new CommandRouter(this);
    this.skills = new SkillsManager({ config });
    this.plugins = new PluginRuntimeManager(this);
    this.schedulerStore = new SchedulerStore();
    this.schedulerService = new SchedulerService(this.schedulerStore, async (job) => {
      await this.sendMessageToSession(job.sessionId, job.prompt, `scheduler:${job.id}`);
    });

    void this.skills.ensureReady();
    void this.plugins.start();
    void this.plugins.runHook('gateway_start', {
      mode: this.securityMode,
      provider: this.config.llm.provider,
      model: this.config.llm.model,
    });
    this.schedulerService.start();

    // Initialize vector memory (non-blocking)
    void this.memoryManager.initialize().catch(() => {
      // Memory system initialization failed — search will be unavailable
    });

    // Start periodic session indexing if enabled
    if (memoryConfig.indexSessions) {
      this.memoryManager.startSessionIndexing(async () => {
        const sessions = this.db.listSessions();
        return sessions.map((s) => ({
          id: s.id,
          messages: s.messages
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({ role: m.role, content: m.content })),
          updatedAt: s.updatedAt,
        }));
      });
    }
  }

  /**
   * Get or create the Gateway singleton
   */
  static getInstance(config?: KeygateConfig): Gateway {
    if (!Gateway.instance) {
      if (!config) {
        throw new Error('Gateway must be initialized with config on first call');
      }
      Gateway.instance = new Gateway(config);
    }
    return Gateway.instance;
  }

  /**
   * Reset the singleton (for testing)
   */
  static reset(): void {
    if (Gateway.instance) {
      void Gateway.instance.plugins.runHook('gateway_stop', {
        mode: Gateway.instance.securityMode,
        provider: Gateway.instance.config.llm.provider,
        model: Gateway.instance.config.llm.model,
      });
      Gateway.instance.brain?.dispose?.();
      Gateway.instance.skills?.stop?.();
      Gateway.instance.plugins?.stop?.();
      Gateway.instance.schedulerService?.stop?.();
      Gateway.instance.memoryManager?.shutdown?.();
      for (const sessionId of Gateway.instance.activeRuns.keys()) {
        Gateway.instance.cancelSessionRun(sessionId, 'disconnect');
      }
    }
    Gateway.instance = null;
  }

  static peekInstance(): Gateway | null {
    return Gateway.instance;
  }

  /**
   * Process an incoming message from any channel
   */
  async processMessage(message: NormalizedMessage): Promise<void> {
    if (!this.sessionWorkspacePaths.has(message.sessionId)) {
      this.sessionWorkspacePaths.set(message.sessionId, this.config.security.workspacePath);
    }
    const queue = this.getOrCreateQueue(message.sessionId);
    
    await queue.enqueue(async () => {
      const incomingHook = await this.plugins.runHook('message_received', {
        sessionId: message.sessionId,
        channelType: message.channelType,
        userId: message.userId,
        content: message.content,
        attachments: message.attachments ?? [],
      });
      const effectiveMessage: NormalizedMessage = {
        ...message,
        content: typeof incomingHook.content === 'string' ? incomingHook.content : message.content,
        attachments: Array.isArray(incomingHook.attachments)
          ? incomingHook.attachments as NormalizedMessage['attachments']
          : message.attachments,
      };

      // Get or create session
      const session = this.getOrCreateSession(effectiveMessage);
      if (await this.commandRouter.maybeHandle(session, effectiveMessage.channel, effectiveMessage.content)) {
        this.appendDebugEvent(effectiveMessage.sessionId, 'command.handled', 'Handled operator command.', {
          content: effectiveMessage.content,
        });
        return;
      }
      const slashResolution = isReservedTerminalSlashCommand(effectiveMessage.content, effectiveMessage.channelType)
        ? { kind: 'none' as const }
        : await this.skills.resolveSlashCommand(effectiveMessage.sessionId, effectiveMessage.content);
      const explicitSkillInvocation = slashResolution.kind === 'prompt'
        ? slashResolution.invocation
        : undefined;
      
      // Add user message to history
      session.messages.push({
        role: 'user',
        content: effectiveMessage.content,
        attachments: effectiveMessage.attachments,
      });
      session.updatedAt = new Date();
      this.emit('message:user', {
        sessionId: effectiveMessage.sessionId,
        channelType: effectiveMessage.channelType,
        content: effectiveMessage.content,
        attachments: effectiveMessage.attachments,
      });
      this.appendDebugEvent(effectiveMessage.sessionId, 'message.user', 'Queued user message.', {
        channelType: effectiveMessage.channelType,
        contentLength: effectiveMessage.content.length,
      });
      this.persistSessionSnapshot(session, {
        role: 'user',
        content: effectiveMessage.content,
        attachments: effectiveMessage.attachments,
      });

      const run = this.startSessionRun(effectiveMessage.sessionId);
      const runContext: ToolExecutionContext = {
        signal: run.controller.signal,
        registerAbortCleanup: (cleanup) => {
          if (run.controller.signal.aborted) {
            this.runAbortCleanup(cleanup);
            return;
          }

          run.abortCleanups.add(cleanup);
        },
      };

      // Emit start event
      this.emit('message:start', {
        sessionId: effectiveMessage.sessionId,
        messageId: effectiveMessage.id,
      });
      this.appendDebugEvent(effectiveMessage.sessionId, 'message.start', 'Started assistant turn.');

      try {
        if (slashResolution.kind === 'dispatch') {
          await this.handleSlashToolDispatch(effectiveMessage, session, slashResolution, runContext);
          return;
        }

        // Stream response back to the channel while accumulating final text.
        let response = '';
        const stream = this.brain.runStream(session, effectiveMessage.channel, {
          explicitSkillInvocation,
          runContext,
        });
        const gateway = this;

        const captureStream = async function* (): AsyncIterable<string> {
          for await (const chunk of stream) {
            response += chunk;
            gateway.emit('message:chunk', {
              sessionId: effectiveMessage.sessionId,
              content: chunk,
            });
            yield chunk;
          }
        };

        await effectiveMessage.channel.sendStream(captureStream());
        if (runContext.signal.aborted) {
          return;
        }
        const finalResponse = formatCapabilitiesAndLimitsForReadability(response || '(No response)');

        // Add assistant response to history
        session.messages.push({
          role: 'assistant',
          content: finalResponse,
        });
        session.updatedAt = new Date();
        this.persistSessionSnapshot(session, {
          role: 'assistant',
          content: finalResponse,
        });

        // Emit end event
        this.emit('message:end', {
          sessionId: effectiveMessage.sessionId,
          content: finalResponse,
        });
        this.appendDebugEvent(effectiveMessage.sessionId, 'message.end', 'Assistant turn completed.', {
          contentLength: finalResponse.length,
        });
        await this.plugins.runHook('message_sent', {
          sessionId: effectiveMessage.sessionId,
          channelType: effectiveMessage.channelType,
          content: finalResponse,
        });
      } catch (error) {
        if (isAbortError(error) || runContext.signal.aborted) {
          return;
        }

        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const errorResponse = `Error: ${errorMessage}`;

        await effectiveMessage.channel.send(errorResponse);

        session.messages.push({
          role: 'assistant',
          content: errorResponse,
        });
        session.updatedAt = new Date();
        this.persistSessionSnapshot(session, {
          role: 'assistant',
          content: errorResponse,
        });

        this.emit('message:end', {
          sessionId: effectiveMessage.sessionId,
          content: errorResponse,
        });
        this.appendDebugEvent(effectiveMessage.sessionId, 'message.error', 'Assistant turn failed.', {
          error: errorMessage,
        });
      } finally {
        this.finishSessionRun(effectiveMessage.sessionId, run);
      }
    });
  }

  getSkillsStatus(sessionId = 'default'): { loadedCount: number; eligibleCount: number; snapshotVersion: string } {
    return this.skills.getStatusSync(sessionId);
  }

  recordTurnUsage(sessionId: string, usage: LLMUsageSnapshot): SessionUsageAggregate {
    const aggregate = this.usage.recordTurnUsage(sessionId, usage);
    const session = this.sessions.get(sessionId);
    if (session) {
      session.usage = aggregate;
      session.updatedAt = new Date();
    }
    this.emit('usage:snapshot', { sessionId, usage, aggregate });
    return aggregate;
  }

  async publishAssistantMessage(
    session: Session,
    content: string,
    options: {
      debugType?: string;
      debugMessage?: string;
      debugData?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    session.messages.push({
      role: 'assistant',
      content,
    });
    session.updatedAt = new Date();
    this.persistSessionSnapshot(session, {
      role: 'assistant',
      content,
    });

    this.emit('message:end', {
      sessionId: session.id,
      content,
    });

    this.appendDebugEvent(
      session.id,
      options.debugType ?? 'message.end',
      options.debugMessage ?? 'Assistant turn completed.',
      options.debugData ?? { contentLength: content.length },
    );

    await this.plugins.runHook('message_sent', {
      sessionId: session.id,
      channelType: session.channelType,
      content,
    });
  }

  setSessionModelOverride(sessionId: string, override: SessionModelOverride | null): void {
    const session = this.getSession(sessionId);
    if (!session) {
      return;
    }

    session.modelOverride = override ?? undefined;
    session.updatedAt = new Date();
    this.db.updateSessionState(sessionId, { modelOverride: override });
  }

  setSessionDebugMode(sessionId: string, enabled: boolean): void {
    const session = this.getSession(sessionId);
    if (!session) {
      return;
    }

    session.debugMode = enabled;
    session.updatedAt = new Date();
    this.db.updateSessionState(sessionId, { debugMode: enabled });
    this.appendDebugEvent(sessionId, 'debug.mode', enabled ? 'Debug mode enabled.' : 'Debug mode disabled.', {
      enabled,
    });
  }

  getSessionDebugMode(sessionId: string): boolean {
    return this.getSession(sessionId)?.debugMode === true;
  }

  getSessionDebugEvents(sessionId: string): SessionDebugEvent[] {
    return [...(this.sessionDebugEvents.get(sessionId) ?? [])];
  }

  async compactSession(sessionId: string): Promise<{ ref: string; summary: string }> {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const beforePayload = await this.plugins.runHook('before_compaction', {
      sessionId,
      messageCount: session.messages.length,
      messages: session.messages.map((message) => ({ ...message })),
    });
    const effectiveSession: Session = beforePayload.messages
      ? {
        ...session,
        messages: beforePayload.messages as Session['messages'],
      }
      : session;

    const summary = await this.brain.compactSessionHistory(effectiveSession);
    const ref = this.db.saveSessionCompaction(sessionId, summary, session.messages.length);
    session.compactionSummaryRef = ref;
    session.updatedAt = new Date();
    this.db.updateSessionState(sessionId, { compactionSummaryRef: ref });
    await this.plugins.runHook('after_compaction', {
      sessionId,
      compactionSummaryRef: ref,
      summary,
      sourceMessageCount: session.messages.length,
    });
    this.appendDebugEvent(sessionId, 'session.compacted', 'Session compaction completed.', {
      ref,
      sourceMessageCount: session.messages.length,
    });
    this.emit('session:compacted', {
      sessionId,
      compactionSummaryRef: ref,
      summary,
    });
    return { ref, summary };
  }

  appendDebugEvent(
    sessionId: string,
    type: string,
    message: string,
    data?: Record<string, unknown>
  ): void {
    const session = this.getSession(sessionId);
    if (!session?.debugMode) {
      return;
    }

    const event: SessionDebugEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      message,
      data,
    };
    const entries = this.sessionDebugEvents.get(sessionId) ?? [];
    entries.push(event);
    while (entries.length > MAX_DEBUG_EVENTS_PER_SESSION) {
      entries.shift();
    }
    this.sessionDebugEvents.set(sessionId, entries);
    this.emit('debug:event', { sessionId, event });
  }

  cancelSessionRun(sessionId: string, reason: SessionCancelReason): void {
    const run = this.activeRuns.get(sessionId);
    if (!run) {
      return;
    }

    if (run.controller.signal.aborted) {
      return;
    }

    run.cancelledReason = reason;
    run.controller.abort();

    if (!run.hardStopTimer) {
      run.hardStopTimer = setTimeout(() => {
        for (const cleanup of run.abortCleanups) {
          this.runAbortCleanup(cleanup);
        }
        run.abortCleanups.clear();
      }, CANCEL_HARD_STOP_TIMEOUT_MS);
    }

    this.emit('session:cancelled', { sessionId, reason });
  }

  private startSessionRun(sessionId: string): ActiveSessionRun {
    const previous = this.activeRuns.get(sessionId);
    if (previous) {
      this.finishSessionRun(sessionId, previous);
    }

    const run: ActiveSessionRun = {
      sessionId,
      controller: new AbortController(),
      abortCleanups: new Set(),
      hardStopTimer: null,
      cancelledReason: null,
    };
    this.activeRuns.set(sessionId, run);
    return run;
  }

  private finishSessionRun(sessionId: string, run: ActiveSessionRun): void {
    if (run.hardStopTimer) {
      clearTimeout(run.hardStopTimer);
    }
    run.abortCleanups.clear();

    if (this.activeRuns.get(sessionId) === run) {
      this.activeRuns.delete(sessionId);
    }
  }

  private runAbortCleanup(cleanup: () => void | Promise<void>): void {
    Promise.resolve(cleanup()).catch((error) => {
      console.warn('Failed to run abort cleanup:', error);
    });
  }

  private async handleSlashToolDispatch(
    message: NormalizedMessage,
    session: Session,
    slashResolution: {
      kind: 'dispatch';
      toolName: string;
      args: Record<string, string>;
      envOverlay: Record<string, string>;
    },
    runContext?: ToolExecutionContext,
  ): Promise<void> {
    const toolCall = {
      id: randomUUID(),
      name: slashResolution.toolName,
      arguments: slashResolution.args,
    };

    const result = await this.toolExecutor.execute(
      toolCall,
      message.channel,
      message.sessionId,
      slashResolution.envOverlay,
      runContext,
    );

    const finalResponse = formatCapabilitiesAndLimitsForReadability(
      result.success ? result.output : `Error: ${result.error ?? 'Unknown error'}`
    );

    await message.channel.send(finalResponse);

    session.messages.push({
      role: 'assistant',
      content: finalResponse,
    });
    session.updatedAt = new Date();
    this.appendDebugEvent(message.sessionId, 'slash.dispatch', 'Slash command dispatched to tool.', {
      toolName: slashResolution.toolName,
    });
    this.persistSessionSnapshot(session, {
      role: 'assistant',
      content: finalResponse,
    });

    this.emit('message:end', {
      sessionId: message.sessionId,
      content: finalResponse,
    });
  }

  /**
   * Get or create a lane queue for a session
   */
  private getOrCreateQueue(sessionId: string): LaneQueue {
    let queue = this.laneQueues.get(sessionId);
    if (!queue) {
      queue = new LaneQueue();
      this.laneQueues.set(sessionId, queue);
    }
    return queue;
  }

  /**
   * Get or create a session
   */
  private getOrCreateSession(message: NormalizedMessage): Session {
    let session = this.sessions.get(message.sessionId);
    if (!session) {
      const persisted = this.db.getSession(message.sessionId);
      session = persisted ?? {
        id: message.sessionId,
        channelType: message.channelType,
        messages: [],
        debugMode: false,
        usage: {
          turnCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.sessions.set(message.sessionId, session);
      if (!persisted) {
        void this.plugins.runHook('session_start', {
          sessionId: message.sessionId,
          channelType: message.channelType,
          delegated: false,
        });
      }
    }
    return session;
  }

  /**
   * Create a new web session
   */
  createWebSession(): Session {
    const session: Session = {
      id: `web:${randomUUID()}`,
      channelType: 'web',
      messages: [],
      debugMode: false,
      usage: {
        turnCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.set(session.id, session);
    this.sessionWorkspacePaths.set(session.id, this.config.security.workspacePath);
    this.persistSessionSnapshot(session);
    void this.plugins.runHook('session_start', {
      sessionId: session.id,
      channelType: session.channelType,
      delegated: false,
    });
    return session;
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId) ?? this.db.getSession(sessionId) ?? undefined;
  }

  /**
   * List all in-memory sessions sorted by most recently updated.
   */
  listSessions(): Session[] {
    const merged = new Map<string, Session>();
    for (const session of this.sessions.values()) {
      merged.set(session.id, {
        ...session,
        messages: session.messages.map((message) => ({ ...message })),
        createdAt: new Date(session.createdAt),
        updatedAt: new Date(session.updatedAt),
      });
    }

    for (const session of this.db.listSessions()) {
      const existing = merged.get(session.id);
      if (!existing || existing.updatedAt.getTime() < session.updatedAt.getTime()) {
        merged.set(session.id, {
          ...session,
          messages: session.messages.map((message) => ({ ...message })),
          createdAt: new Date(session.createdAt),
          updatedAt: new Date(session.updatedAt),
        });
      }

      // Preserve title from DB if memory doesn't have one
      if (existing && !existing.title && session.title) {
        existing.title = session.title;
      }
    }

    return Array.from(merged.values())
      .map((session) => ({
        ...session,
        messages: session.messages.map((message) => ({ ...message })),
        createdAt: new Date(session.createdAt),
        updatedAt: new Date(session.updatedAt),
      }))
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  }

  setSessionWorkspace(sessionId: string, workspacePath: string): void {
    const normalized = workspacePath.trim();
    if (!normalized) {
      return;
    }
    this.sessionWorkspacePaths.set(sessionId, normalized);
  }

  async prepareSessionWorkspace(sessionId: string, workspacePath: string): Promise<void> {
    const normalized = workspacePath.trim();
    if (!normalized) {
      return;
    }

    this.sessionWorkspacePaths.set(sessionId, normalized);
    try {
      await ensureWorkspaceGitRepo(normalized);
    } catch (error) {
      console.warn(
        `Failed to initialize local git repo for session workspace "${normalized}":`,
        error,
      );
    }
  }

  getSessionWorkspace(sessionId: string): string | undefined {
    return this.sessionWorkspacePaths.get(sessionId);
  }

  spawnDelegatedSession(parentSessionId: string, label?: string): DelegatedSessionRecord {
    const parent = this.getSession(parentSessionId);
    void this.plugins.runHook('subagent_spawning', {
      parentSessionId,
      requestedLabel: label?.trim() || '',
      channelType: parent?.channelType ?? 'web',
    });
    const now = new Date().toISOString();
    const session: Session = {
      id: `sub:${randomUUID()}`,
      channelType: parent?.channelType ?? 'web',
      title: label?.trim() || `Sub-agent for ${parentSessionId}`,
      messages: [],
      debugMode: false,
      usage: {
        turnCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.set(session.id, session);
    const parentWorkspace = this.sessionWorkspacePaths.get(parentSessionId) ?? this.config.security.workspacePath;
    this.sessionWorkspacePaths.set(session.id, parentWorkspace);
    this.persistSessionSnapshot(session);

    const record: DelegatedSessionRecord = {
      sessionId: session.id,
      parentSessionId,
      label: label?.trim() || '',
      createdAt: now,
      updatedAt: now,
      status: 'idle',
    };
    this.delegatedSessions.set(session.id, record);
    void this.plugins.runHook('session_start', {
      sessionId: session.id,
      channelType: session.channelType,
      delegated: true,
      parentSessionId,
    });
    void this.plugins.runHook('subagent_spawned', {
      parentSessionId,
      sessionId: session.id,
      label: record.label,
      channelType: session.channelType,
    });
    return { ...record };
  }

  listDelegatedSessions(parentSessionId?: string): DelegatedSessionRecord[] {
    return Array.from(this.delegatedSessions.values())
      .filter((item) => !parentSessionId || item.parentSessionId === parentSessionId)
      .map((item) => {
        const active = this.activeRuns.has(item.sessionId);
        const status: DelegatedSessionRecord['status'] = active ? 'running' : item.status;
        return { ...item, status };
      })
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  getSessionHistory(sessionId: string, limit = 50): Session['messages'] {
    const session = this.getSession(sessionId);
    if (!session) {
      return [];
    }

    return session.messages.slice(-Math.max(1, limit)).map((msg) => ({ ...msg }));
  }

  registerProactiveSender(channelType: string, sender: (sessionId: string, content: string) => Promise<void>): void {
    this.proactiveSenders.set(channelType, sender);
  }

  async sendMessageToSession(sessionId: string, content: string, userId = 'delegate:system'): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const record = this.delegatedSessions.get(sessionId);
    if (record) {
      record.updatedAt = new Date().toISOString();
      record.status = 'running';
    }

    const proactiveSender = this.proactiveSenders.get(session.channelType);
    const channel = proactiveSender
      ? createProactiveChannel(session.channelType, sessionId, proactiveSender)
      : createInternalDelegationChannel(session.channelType);

    await this.processMessage({
      id: randomUUID(),
      sessionId,
      channelType: session.channelType,
      channel,
      userId,
      content,
      timestamp: new Date(),
    });

    if (record) {
      record.updatedAt = new Date().toISOString();
      if (record.status !== 'cancelled') {
        record.status = 'idle';
      }
    }
  }

  async steerDelegatedSession(sessionId: string, content: string): Promise<void> {
    await this.sendMessageToSession(sessionId, `[STEER]\n${content}`, 'delegate:steer');
  }

  killDelegatedSession(sessionId: string, reason: SessionCancelReason = 'user'): void {
    this.cancelSessionRun(sessionId, reason);
    const record = this.delegatedSessions.get(sessionId);
    if (record) {
      record.status = 'cancelled';
      record.updatedAt = new Date().toISOString();
      void this.plugins.runHook('subagent_ended', {
        parentSessionId: record.parentSessionId,
        sessionId,
        reason,
      });
    }
  }

  async listScheduledJobs(): Promise<ScheduledJob[]> {
    return this.schedulerStore.listJobs();
  }

  async createScheduledJob(input: ScheduledJobCreateInput): Promise<ScheduledJob> {
    return this.schedulerStore.createJob(input);
  }

  async updateScheduledJob(jobId: string, patch: ScheduledJobUpdateInput): Promise<ScheduledJob> {
    return this.schedulerStore.updateJob(jobId, patch);
  }

  async deleteScheduledJob(jobId: string): Promise<boolean> {
    return this.schedulerStore.deleteJob(jobId);
  }

  async triggerScheduledJob(jobId: string): Promise<ScheduledJob> {
    const firedAt = new Date();
    const job = await this.schedulerStore.markTriggered(jobId, firedAt);
    await this.sendMessageToSession(job.sessionId, job.prompt, `scheduler:${job.id}`);
    return job;
  }

  /**
   * Get current security mode
   */
  getSecurityMode(): SecurityMode {
    return this.securityMode;
  }

  getSpicyModeEnabled(): boolean {
    return this.config.security.spicyModeEnabled;
  }

  getSpicyMaxObedienceEnabled(): boolean {
    return this.config.security.spicyMaxObedienceEnabled === true;
  }

  getLLMState(sessionId?: string): {
    provider: KeygateConfig['llm']['provider'];
    model: string;
    reasoningEffort?: CodexReasoningEffort;
  } {
    const override = sessionId ? this.getSession(sessionId)?.modelOverride : undefined;
    return {
      provider: override?.provider ?? this.config.llm.provider,
      model: override?.model ?? this.brain.getLLMModel(),
      reasoningEffort: override?.reasoningEffort ?? this.config.llm.reasoningEffort,
    };
  }

  async listAvailableModels(
    provider: KeygateConfig['llm']['provider'] = this.config.llm.provider
  ): Promise<ProviderModelOption[]> {
    if (provider === this.config.llm.provider) {
      return this.brain.listModels();
    }

    const tempConfig: KeygateConfig = {
      ...this.config,
      llm: {
        ...this.config.llm,
        provider,
        model: getDefaultModelForProvider(provider),
      },
    };

    const providerInstance = createLLMProvider(tempConfig);

    try {
      if (typeof providerInstance.listModels === 'function') {
        return await providerInstance.listModels();
      }

      return [{
        id: tempConfig.llm.model,
        provider,
        displayName: tempConfig.llm.model,
        isDefault: true,
      }];
    } finally {
      if (typeof providerInstance.dispose === 'function') {
        await providerInstance.dispose();
      }
    }
  }

  async setLLMSelection(
    provider: KeygateConfig['llm']['provider'],
    model: string,
    reasoningEffort?: CodexReasoningEffort
  ): Promise<void> {
    this.config.llm.provider = provider;
    this.config.llm.model = model;
    if (provider === 'openai-codex') {
      this.config.llm.reasoningEffort = reasoningEffort ?? this.config.llm.reasoningEffort ?? 'medium';
    }

    await this.brain.setLLMSelection(provider, model, this.config.llm.reasoningEffort);
  }

  /**
   * Set security mode (requires spicy mode to be enabled in config)
   */
  setSecurityMode(mode: SecurityMode): void {
    if (mode === 'spicy' && !this.config.security.spicyModeEnabled) {
      throw new Error('Spicy mode is not enabled. Re-run installer and accept the risk.');
    }
    this.securityMode = mode;
    this.toolExecutor.setMode(mode);
    this.emit('mode:changed', { mode });
  }

  setSpicyModeEnabled(enabled: boolean): void {
    if (enabled === this.config.security.spicyModeEnabled) {
      return;
    }

    if (!enabled && this.securityMode === 'spicy') {
      throw new Error('Cannot disable spicy mode while spicy mode is active.');
    }

    this.config.security.spicyModeEnabled = enabled;
    if (!enabled) {
      this.config.security.spicyMaxObedienceEnabled = false;
    }

    this.emit('spicy_enabled:changed', { enabled });
  }

  setSpicyMaxObedienceEnabled(enabled: boolean): void {
    if (enabled && !this.config.security.spicyModeEnabled) {
      throw new Error(
        'Spicy max-obedience is unavailable because spicy mode is not enabled. Re-run installer and accept the risk.'
      );
    }

    this.config.security.spicyMaxObedienceEnabled = enabled;
    this.emit('spicy_obedience:changed', { enabled });
  }

  /**
   * Clear a session's message history
   */
  clearSession(sessionId: string): void {
    this.cancelSessionRun(sessionId, 'user');

    const session = this.sessions.get(sessionId);
    const attachmentPaths = new Set<string>([
      ...collectAttachmentPaths(session?.messages ?? []),
      ...this.db.getSessionAttachmentPaths(sessionId),
    ]);

    void this.removeAttachmentFiles(attachmentPaths).catch((error) => {
      console.error('Failed to remove session attachments:', error);
    });

    if (session) {
      session.messages = [];
      session.updatedAt = new Date();
      this.persistSessionSnapshot(session);
    }

    try {
      this.db.clearSession(sessionId);
      this.sessionDebugEvents.delete(sessionId);
      void this.plugins.runHook('session_end', {
        sessionId,
        reason: 'cleared',
      });
    } catch (error) {
      console.error('Failed to clear persisted session messages:', error);
    }
  }

  /**
   * Delete a session entirely (memory + database)
   */
  deleteSession(sessionId: string): string {
    const resolvedSessionId = this.resolveSessionIdForMutation(sessionId);

    this.cancelSessionRun(resolvedSessionId, 'user');

    const session = this.sessions.get(resolvedSessionId);
    const attachmentPaths = new Set<string>([
      ...collectAttachmentPaths(session?.messages ?? []),
      ...this.db.getSessionAttachmentPaths(resolvedSessionId),
    ]);

    void this.removeAttachmentFiles(attachmentPaths).catch((error) => {
      console.error('Failed to remove session attachments:', error);
    });

    this.sessions.delete(resolvedSessionId);
    this.laneQueues.delete(resolvedSessionId);
    this.sessionWorkspacePaths.delete(resolvedSessionId);
    this.sessionDebugEvents.delete(resolvedSessionId);
    this.delegatedSessions.delete(resolvedSessionId);
    for (const [delegatedSessionId, record] of this.delegatedSessions.entries()) {
      if (record.parentSessionId === resolvedSessionId) {
        this.delegatedSessions.delete(delegatedSessionId);
        this.sessionWorkspacePaths.delete(delegatedSessionId);
      }
    }

    try {
      this.db.deleteSession(resolvedSessionId);
      void this.plugins.runHook('session_end', {
        sessionId: resolvedSessionId,
        reason: 'deleted',
      });
    } catch (error) {
      console.error('Failed to delete persisted session:', error);
    }

    return resolvedSessionId;
  }

  /**
   * Rename a session (update title)
   */
  renameSession(sessionId: string, title: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.title = title;
      session.updatedAt = new Date();
      this.persistSessionSnapshot(session);
    }

    try {
      this.db.updateSessionTitle(sessionId, title);
    } catch (error) {
      console.error('Failed to update session title:', error);
    }
  }

  private resolveSessionIdForMutation(sessionId: string): string {
    const trimmed = sessionId.trim();
    if (!trimmed) {
      return sessionId;
    }

    if (this.sessionExists(trimmed)) {
      return trimmed;
    }

    if (!trimmed.includes(':')) {
      const prefixed = `web:${trimmed}`;
      if (this.sessionExists(prefixed)) {
        return prefixed;
      }
    }

    return trimmed;
  }

  private sessionExists(sessionId: string): boolean {
    if (this.sessions.has(sessionId)) {
      return true;
    }

    return this.db.getSession(sessionId) !== null;
  }

  private persistSessionSnapshot(
    session: Session,
    message?: Pick<Session['messages'][number], 'role' | 'content' | 'attachments'>
  ): void {
    try {
      this.db.saveSession(session);
      if (message) {
        this.db.saveMessage(session.id, {
          role: message.role,
          content: message.content,
          attachments: message.attachments,
        });
      }
    } catch (error) {
      console.error('Failed to persist session state:', error);
    }
  }

  private async removeAttachmentFiles(pathsToDelete: Iterable<string>): Promise<void> {
    const uploadRoot = path.resolve(path.join(this.config.security.workspacePath, '.keygate-uploads'));

    for (const filePath of pathsToDelete) {
      const resolvedPath = path.resolve(filePath);
      if (!isPathWithinRoot(uploadRoot, resolvedPath)) {
        continue;
      }

      try {
        await fs.unlink(resolvedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }
}

function isReservedTerminalSlashCommand(content: string, channelType: Session['channelType']): boolean {
  if (channelType !== 'terminal') {
    return false;
  }

  const normalized = content.trim().toLowerCase();
  return normalized === '/help' || normalized === '/new' || normalized === '/exit' || normalized === '/quit';
}

function createProactiveChannel(
  type: Session['channelType'],
  sessionId: string,
  sender: (sessionId: string, content: string) => Promise<void>
): Channel {
  return {
    type,
    async send(content: string) {
      await sender(sessionId, content);
    },
    async sendStream(stream: AsyncIterable<string>) {
      let buffer = '';
      for await (const chunk of stream) {
        buffer += chunk;
      }
      if (buffer) {
        await sender(sessionId, buffer);
      }
    },
    async requestConfirmation() {
      return 'allow_once' as const;
    },
  };
}

function createInternalDelegationChannel(type: Session['channelType']): Channel {
  return {
    type,
    async send(_content: string) {
      // Internal delegated run: response is persisted into session history by gateway pipeline.
    },
    async sendStream(stream: AsyncIterable<string>) {
      for await (const _chunk of stream) {
        // Consume stream so model output fully executes.
      }
    },
    async requestConfirmation() {
      return 'allow_once' as const;
    },
  };
}

function getDefaultModelForProvider(provider: KeygateConfig['llm']['provider']): string {
  switch (provider) {
    case 'openai':
      return 'gpt-4o';
    case 'gemini':
      return 'gemini-1.5-pro';
    case 'ollama':
      return 'llama3';
    case 'openai-codex':
      return 'openai-codex/gpt-5.3';
    default:
      return 'gpt-4o';
  }
}

function collectAttachmentPaths(messages: Session['messages']): string[] {
  const paths = new Set<string>();

  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      const normalizedPath = attachment.path.trim();
      if (!normalizedPath) {
        continue;
      }

      paths.add(normalizedPath);
    }
  }

  return Array.from(paths);
}

function isPathWithinRoot(rootDir: string, targetPath: string): boolean {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);

  if (resolvedTarget === resolvedRoot) {
    return true;
  }

  return resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
