import { EventEmitter } from 'eventemitter3';
import { randomUUID } from 'node:crypto';
import type {
  CodexReasoningEffort,
  KeygateConfig,
  KeygateEvents,
  NormalizedMessage,
  ProviderModelOption,
  SecurityMode,
  Session,
} from '../types.js';
import { LaneQueue } from './LaneQueue.js';
import { Brain } from '../brain/Brain.js';
import { formatCapabilitiesAndLimitsForReadability } from '../brain/assistantOutputFormatter.js';
import { ToolExecutor } from '../tools/ToolExecutor.js';
import { Database } from '../db/index.js';
import { createLLMProvider } from '../llm/index.js';
import { SkillsManager } from '../skills/index.js';

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
  private securityMode: SecurityMode = 'safe';

  public readonly brain: Brain;
  public readonly toolExecutor: ToolExecutor;
  public readonly db: Database;
  public readonly config: KeygateConfig;
  public readonly skills: SkillsManager;

  private constructor(config: KeygateConfig) {
    super();
    this.config = config;
    this.securityMode = config.security.mode;
    if (!this.config.security.spicyModeEnabled) {
      this.config.security.spicyMaxObedienceEnabled = false;
    }

    // Initialize database
    this.db = new Database();

    // Initialize tool executor with security settings
    this.toolExecutor = new ToolExecutor(
      this.securityMode,
      config.security.workspacePath,
      config.security.allowedBinaries,
      this
    );

    // Initialize brain with LLM provider
    this.brain = new Brain(config, this.toolExecutor, this);
    this.skills = new SkillsManager({ config });
    void this.skills.ensureReady();
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
    Gateway.instance?.skills.stop();
    Gateway.instance = null;
  }

  /**
   * Process an incoming message from any channel
   */
  async processMessage(message: NormalizedMessage): Promise<void> {
    const queue = this.getOrCreateQueue(message.sessionId);
    
    await queue.enqueue(async () => {
      // Get or create session
      const session = this.getOrCreateSession(message);
      const slashResolution = isReservedTerminalSlashCommand(message.content, message.channelType)
        ? { kind: 'none' as const }
        : await this.skills.resolveSlashCommand(message.sessionId, message.content);
      const explicitSkillInvocation = slashResolution.kind === 'prompt'
        ? slashResolution.invocation
        : undefined;
      
      // Add user message to history
      session.messages.push({
        role: 'user',
        content: message.content,
      });
      session.updatedAt = new Date();
      this.emit('message:user', {
        sessionId: message.sessionId,
        channelType: message.channelType,
        content: message.content,
      });
      this.persistSessionSnapshot(session, {
        role: 'user',
        content: message.content,
      });

      // Emit start event
      this.emit('message:start', {
        sessionId: message.sessionId,
        messageId: message.id,
      });

      try {
        if (slashResolution.kind === 'dispatch') {
          await this.handleSlashToolDispatch(message, session, slashResolution);
          return;
        }

        // Stream response back to the channel while accumulating final text.
        let response = '';
        const stream = this.brain.runStream(session, message.channel, {
          explicitSkillInvocation,
        });
        const gateway = this;

        const captureStream = async function* (): AsyncIterable<string> {
          for await (const chunk of stream) {
            response += chunk;
            gateway.emit('message:chunk', {
              sessionId: message.sessionId,
              content: chunk,
            });
            yield chunk;
          }
        };

        await message.channel.sendStream(captureStream());
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
          sessionId: message.sessionId,
          content: finalResponse,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const errorResponse = `Error: ${errorMessage}`;

        await message.channel.send(errorResponse);

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
          sessionId: message.sessionId,
          content: errorResponse,
        });
      }
    });
  }

  getSkillsStatus(sessionId = 'default'): { loadedCount: number; eligibleCount: number; snapshotVersion: string } {
    return this.skills.getStatusSync(sessionId);
  }

  private async handleSlashToolDispatch(
    message: NormalizedMessage,
    session: Session,
    slashResolution: {
      kind: 'dispatch';
      toolName: string;
      args: Record<string, string>;
      envOverlay: Record<string, string>;
    }
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
      slashResolution.envOverlay
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
      session = this.db.getSession(message.sessionId) ?? {
        id: message.sessionId,
        channelType: message.channelType,
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.sessions.set(message.sessionId, session);
    }
    return session;
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
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

  getLLMState(): {
    provider: KeygateConfig['llm']['provider'];
    model: string;
    reasoningEffort?: CodexReasoningEffort;
  } {
    return {
      provider: this.config.llm.provider,
      model: this.brain.getLLMModel(),
      reasoningEffort: this.config.llm.reasoningEffort,
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
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages = [];
      session.updatedAt = new Date();
      this.persistSessionSnapshot(session);
    }

    try {
      this.db.clearSession(sessionId);
    } catch (error) {
      console.error('Failed to clear persisted session messages:', error);
    }
  }

  private persistSessionSnapshot(
    session: Session,
    message?: Pick<Session['messages'][number], 'role' | 'content'>
  ): void {
    try {
      this.db.saveSession(session);
      if (message) {
        this.db.saveMessage(session.id, {
          role: message.role,
          content: message.content,
        });
      }
    } catch (error) {
      console.error('Failed to persist session state:', error);
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
