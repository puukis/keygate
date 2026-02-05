import { EventEmitter } from 'eventemitter3';
import type {
  KeygateConfig,
  KeygateEvents,
  NormalizedMessage,
  SecurityMode,
  Session,
} from '../types.js';
import { LaneQueue } from './LaneQueue.js';
import { Brain } from '../brain/Brain.js';
import { ToolExecutor } from '../tools/ToolExecutor.js';
import { Database } from '../db/index.js';

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

  private constructor(config: KeygateConfig) {
    super();
    this.config = config;
    this.securityMode = config.security.mode;

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
      
      // Add user message to history
      session.messages.push({
        role: 'user',
        content: message.content,
      });
      session.updatedAt = new Date();

      // Emit start event
      this.emit('message:start', {
        sessionId: message.sessionId,
        messageId: message.id,
      });

      try {
        // Run the brain (agent loop)
        const response = await this.brain.run(session, message.channel);

        // Add assistant response to history
        session.messages.push({
          role: 'assistant',
          content: response,
        });

        // Emit end event
        this.emit('message:end', {
          sessionId: message.sessionId,
          content: response,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.emit('message:end', {
          sessionId: message.sessionId,
          content: `Error: ${errorMessage}`,
        });
        throw error;
      }
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
      session = {
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
   * Get current security mode
   */
  getSecurityMode(): SecurityMode {
    return this.securityMode;
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

  /**
   * Clear a session's message history
   */
  clearSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages = [];
      session.updatedAt = new Date();
    }
  }
}
