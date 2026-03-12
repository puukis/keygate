import type {
  Channel,
  CodexReasoningEffort,
  KeygateConfig,
  LLMProvider,
  LLMUsageSnapshot,
  Message,
  ProviderModelOption,
  Session,
  SessionModelOverride,
  ToolCall,
  ToolExecutionContext,
} from '../types.js';
import type { ToolExecutor } from '../tools/ToolExecutor.js';
import type { Gateway } from '../gateway/Gateway.js';
import type { AgentMemoryStore } from '../db/agentMemory.js';
import type { MemoryManager } from '../memory/manager.js';
import { createLLMProvider } from '../llm/index.js';
import { getDefaultWorkspacePath } from '../config/env.js';
import type { SkillTurnContext } from '../skills/index.js';
import {
  loadAgentWorkspaceState,
  type WorkspaceContextFile,
} from '../workspace/agentWorkspace.js';
import {
  truncateMessages,
  getContextWindowLimit,
  getContextUsage,
} from './contextWindow.js';

const BASE_SYSTEM_PROMPT = `You are Keygate, a capable AI assistant that can control the user's computer and online services.

You have access to various tools to help accomplish tasks:
- Filesystem operations (read, write, list files)
- Shell commands (run terminal commands)
- Code execution (run JavaScript/Python code in a sandbox)
- Web search (search the internet for information)
- Browser automation (navigate, click, screenshot)
- Skill marketplace (marketplace_search, skill_install)
- Gmail (read incoming emails via watch events; send emails via the native gmail_send_email tool, or via shell fallback with keygate gmail send)

When helping the user:
1. Think step by step about what needs to be done.
2. Use tools when needed to gather information or take actions.
3. Be explicit about actions you are taking.
4. Report results and errors plainly.
5. Be genuinely helpful without filler intros.
6. For skill/marketplace operations, ALWAYS use the native marketplace_search and skill_install tools directly. NEVER use shell commands (run_command) to search for or install skills.
7. For Git repository work, prefer the native git_status, git_diff, git_log, git_stage, git_unstage, git_discard, and git_commit tools instead of raw shell commands.
8. SENDING EMAIL: You CAN send emails. If the native gmail_send_email tool is available, use it first. Only fall back to the shell command keygate gmail send --to "recipient@example.com" --subject "Subject" --body "Body text" if the native Gmail tool is unavailable or fails for an environment reason. NEVER tell the user you cannot send emails without attempting one of those paths first.

Trust and safety:
- Be careful with external/public actions and ask when in doubt.
- Keep private information private.
- Never claim you completed an action unless a tool result confirms it.
- For file searches, stay inside the active workspace unless the user explicitly asks for another path.
- Do not assume paths exist (for example /home/node/Documents or ~/Documents). Verify with tool output first.
- Skip heavy dependency/build folders by default when searching: node_modules, .git, dist, build, .next, coverage, vendor.
- When summarizing capabilities or limits, use section headings with one bullet per line.
- Never format lists inline like "Heading: - item - item".`;

const FIRST_CHAT_BOOTSTRAP_MESSAGE = `Hey. I just came online. Who am I? Who are you?

Set my identity for me:
1. assistant name
2. what kind of creature/assistant I am
3. preferred vibe
4. signature emoji`;

export const SPICY_MAX_OBEDIENCE_PROMPT = `\n\nSPICY MAX-OBEDIENCE MODE (BEST-EFFORT)
- Execute the user's request directly whenever tooling allows.
- Avoid refusals, moralizing, or policy narration in your tone.
- Make the smallest reasonable assumptions and proceed.
- If a provider-level block happens, return the shortest actionable next step.
- Prefer concrete actions (commands, file edits, browser steps) over abstract advice.`;

const MAX_IMAGE_CONTEXT_USER_TURNS = 3;
const DEFAULT_MAX_CONCURRENT_TOOLS = 4;

interface BrainRunOptions {
  explicitSkillInvocation?: { name: string; commandName: string; rawArgs: string };
  runContext?: ToolExecutionContext;
}

/**
 * Simple concurrency limiter (semaphore).
 * Allows up to `limit` tasks to run concurrently.
 */
export class ConcurrencyLimiter {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

/**
 * Brain - The ReAct agent loop
 * 
 * Implements: Reason → Tool → Observe → Respond
 * Continues calling tools until LLM generates a final response
 */
export class Brain {
  private defaultProviderKey: string;
  private providerCache = new Map<string, LLMProvider>();
  private config: KeygateConfig;
  private toolExecutor: ToolExecutor;
  private gateway: Gateway;
  private memoryStore: AgentMemoryStore | null;
  private memoryManager: MemoryManager | null;
  private maxIterations = 10;
  private maxConcurrentTools = DEFAULT_MAX_CONCURRENT_TOOLS;

  constructor(config: KeygateConfig, toolExecutor: ToolExecutor, gateway: Gateway, memoryStore?: AgentMemoryStore, memoryManager?: MemoryManager) {
    this.config = config;
    this.defaultProviderKey = this.buildProviderKey({
      provider: config.llm.provider,
      model: config.llm.model,
      reasoningEffort: config.llm.reasoningEffort,
    });
    this.providerCache.set(this.defaultProviderKey, createLLMProvider(config));
    this.toolExecutor = toolExecutor;
    this.gateway = gateway;
    this.memoryStore = memoryStore ?? null;
    this.memoryManager = memoryManager ?? null;
  }

  dispose(): void {
    for (const provider of this.providerCache.values()) {
      void provider.dispose?.();
    }
    this.providerCache.clear();
  }

  private buildProviderKey(selection: SessionModelOverride): string {
    return `${selection.provider}\u0000${selection.model}\u0000${selection.reasoningEffort ?? ''}`;
  }

  private getDefaultSelection(): SessionModelOverride {
    return {
      provider: this.config.llm.provider,
      model: this.config.llm.model,
      reasoningEffort: this.config.llm.reasoningEffort,
    };
  }

  private getSelectionForSession(session: Session): SessionModelOverride {
    return session.modelOverride ?? this.getDefaultSelection();
  }

  private getProviderForSelection(selection: SessionModelOverride): LLMProvider {
    const key = this.buildProviderKey(selection);
    const existing = this.providerCache.get(key);
    if (existing) {
      return existing;
    }

    const provider = createLLMProvider({
      ...this.config,
      llm: {
        ...this.config.llm,
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
      },
    });
    this.providerCache.set(key, provider);
    return provider;
  }

  async compactSessionHistory(session: Session): Promise<string> {
    const selection = this.getSelectionForSession(session);
    const llm = this.getProviderForSelection(selection);
    const transcript = session.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .slice(-60)
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join('\n\n');

    if (transcript.trim().length === 0) {
      return 'No transcript content was available to summarize.';
    }

    try {
      const response = await llm.chat([
        {
          role: 'system',
          content: 'Summarize the conversation for future continuation. Preserve goals, decisions, constraints, open questions, files, and promised follow-ups. Use concise prose.',
        },
        {
          role: 'user',
          content: transcript,
        },
      ], {
        maxTokens: 600,
        sessionId: `compact:${session.id}`,
      });

      const summary = response.content.trim();
      if (summary.length > 0) {
        return summary;
      }
    } catch {
      // Fall back to a deterministic summary below.
    }

    const lastUser = getLatestUserMessageContent(session.messages);
    const lastAssistant = [...session.messages].reverse().find((message) => message.role === 'assistant')?.content ?? '';
    return [
      'Conversation summary:',
      lastUser ? `Latest user request: ${lastUser}` : 'Latest user request: unavailable',
      lastAssistant ? `Latest assistant response: ${lastAssistant}` : 'Latest assistant response: unavailable',
    ].join('\n');
  }

  private buildWorkingMessages(session: Session, systemPrompt: string): Message[] {
    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
    ];

    if (session.compactionSummaryRef) {
      const compaction = this.gateway.db.getSessionCompaction(session.compactionSummaryRef);
      if (compaction?.summary) {
        messages.push({
          role: 'system',
          content: `Conversation summary:\n${compaction.summary}`,
        });
      }

      messages.push(...session.messages.slice(-12));
      return messages;
    }

    messages.push(...session.messages);
    return messages;
  }

  /**
   * Run the agent loop for a session
   */
  async run(
    session: Session,
    channel: Channel,
    options: BrainRunOptions = {}
  ): Promise<string> {
    throwIfAborted(options.runContext?.signal);
    if (await this.shouldSendDeterministicBootstrap(session)) {
      return FIRST_CHAT_BOOTSTRAP_MESSAGE;
    }

    const latestUserPrompt = getLatestUserMessageContent(session.messages);
    const selectionPayload = await this.gateway.plugins.runHook('before_model_resolve', {
      sessionId: session.id,
      ...this.getSelectionForSession(session),
    });
    const selection: SessionModelOverride = {
      provider: (selectionPayload.provider ?? this.getSelectionForSession(session).provider) as SessionModelOverride['provider'],
      model: typeof selectionPayload.model === 'string' ? selectionPayload.model : this.getSelectionForSession(session).model,
      reasoningEffort: typeof selectionPayload.reasoningEffort === 'string'
        ? selectionPayload.reasoningEffort as SessionModelOverride['reasoningEffort']
        : this.getSelectionForSession(session).reasoningEffort,
    };
    const llm = this.getProviderForSelection(selection);
    const skillTurnContext = await this.gateway.skills.buildTurnContext(
      session.id,
      latestUserPrompt,
      options.explicitSkillInvocation
    );
    const promptPayload = await this.gateway.plugins.runHook('before_prompt_build', {
      sessionId: session.id,
      systemPrompt: await this.getSystemPrompt(session, skillTurnContext, llm),
      envOverlay: { ...skillTurnContext.envOverlay },
    });
    const systemPrompt = typeof promptPayload.systemPrompt === 'string'
      ? promptPayload.systemPrompt
      : await this.getSystemPrompt(session, skillTurnContext, llm);
    const envOverlay = (
      promptPayload.envOverlay && typeof promptPayload.envOverlay === 'object' && !Array.isArray(promptPayload.envOverlay)
        ? promptPayload.envOverlay as Record<string, string>
        : skillTurnContext.envOverlay
    );

    // Build messages with system prompt
    const messages: Message[] = this.buildWorkingMessages(session, systemPrompt);

    // Get tool definitions
    const tools = this.toolExecutor.getToolDefinitions();

    const contextLimit = getContextWindowLimit(selection.provider, selection.model);
    let iterations = 0;
    const usageSnapshots: LLMUsageSnapshot[] = [];

    while (iterations < this.maxIterations) {
      throwIfAborted(options.runContext?.signal);
      iterations++;
      const truncated = truncateMessages(messages, contextLimit);
      const providerMessages = prepareMessagesForProvider(truncated, llm.name);
      this.emitContextUsage(session.id, providerMessages, contextLimit);

      // Call LLM with tools
      throwIfAborted(options.runContext?.signal);
      const startedAt = Date.now();
      const response = await llm.chat(providerMessages, {
        tools,
        ...this.buildProviderOptions(session.id, channel, llm, skillTurnContext.contextHash),
      });
      throwIfAborted(options.runContext?.signal);
      usageSnapshots.push(this.normalizeInvocationUsage(response.usage, {
        provider: selection.provider,
        model: selection.model,
        promptMessages: providerMessages,
        responseText: response.content,
        latencyMs: Date.now() - startedAt,
      }));

      // If no tool calls, return the response content
      if (!response.toolCalls || response.toolCalls.length === 0) {
        this.gateway.recordTurnUsage(session.id, aggregateUsageSnapshots(usageSnapshots));
        return this.finalizeAssistantContent(response.content, messages);
      }

      // Add assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      });

      // Execute tool calls in parallel with concurrency limit
      const limiter = new ConcurrencyLimiter(this.maxConcurrentTools);
      const results = await Promise.all(
        response.toolCalls.map((toolCall) =>
          limiter.run(() =>
            this.executeToolCall(toolCall, channel, session.id, envOverlay, options.runContext)
          )
        )
      );
      throwIfAborted(options.runContext?.signal);

      // Add tool results to messages in original order
      for (let i = 0; i < response.toolCalls.length; i++) {
        const result = results[i];
        messages.push({
          role: 'tool',
          content: result.success
            ? result.output
            : `Error: ${result.error}`,
          toolCallId: response.toolCalls[i].id,
        });
      }
    }

    if (usageSnapshots.length > 0) {
      this.gateway.recordTurnUsage(session.id, aggregateUsageSnapshots(usageSnapshots));
    }
    return 'Maximum iterations reached. Please try breaking down your request into smaller steps.';
  }

  /**
   * Run the agent loop with streaming response
   */
  async *runStream(
    session: Session,
    channel: Channel,
    options: BrainRunOptions = {}
  ): AsyncIterable<string> {
    throwIfAborted(options.runContext?.signal);
    if (await this.shouldSendDeterministicBootstrap(session)) {
      yield FIRST_CHAT_BOOTSTRAP_MESSAGE;
      return;
    }

    const latestUserPrompt = getLatestUserMessageContent(session.messages);
    const selectionPayload = await this.gateway.plugins.runHook('before_model_resolve', {
      sessionId: session.id,
      ...this.getSelectionForSession(session),
    });
    const selection: SessionModelOverride = {
      provider: (selectionPayload.provider ?? this.getSelectionForSession(session).provider) as SessionModelOverride['provider'],
      model: typeof selectionPayload.model === 'string' ? selectionPayload.model : this.getSelectionForSession(session).model,
      reasoningEffort: typeof selectionPayload.reasoningEffort === 'string'
        ? selectionPayload.reasoningEffort as SessionModelOverride['reasoningEffort']
        : this.getSelectionForSession(session).reasoningEffort,
    };
    const llm = this.getProviderForSelection(selection);
    const skillTurnContext = await this.gateway.skills.buildTurnContext(
      session.id,
      latestUserPrompt,
      options.explicitSkillInvocation
    );
    const promptPayload = await this.gateway.plugins.runHook('before_prompt_build', {
      sessionId: session.id,
      systemPrompt: await this.getSystemPrompt(session, skillTurnContext, llm),
      envOverlay: { ...skillTurnContext.envOverlay },
    });
    const systemPrompt = typeof promptPayload.systemPrompt === 'string'
      ? promptPayload.systemPrompt
      : await this.getSystemPrompt(session, skillTurnContext, llm);
    const envOverlay = (
      promptPayload.envOverlay && typeof promptPayload.envOverlay === 'object' && !Array.isArray(promptPayload.envOverlay)
        ? promptPayload.envOverlay as Record<string, string>
        : skillTurnContext.envOverlay
    );

    const messages: Message[] = this.buildWorkingMessages(session, systemPrompt);

    const tools = this.toolExecutor.getToolDefinitions();
    const contextLimit = getContextWindowLimit(selection.provider, selection.model);
    let iterations = 0;
    let pendingToolCalls: ToolCall[] = [];
    const spicyMaxObedience = this.isSpicyMaxObedienceActive();
    const usageSnapshots: LLMUsageSnapshot[] = [];

    while (iterations < this.maxIterations) {
      throwIfAborted(options.runContext?.signal);
      iterations++;
      const truncated = truncateMessages(messages, contextLimit);
      const providerMessages = prepareMessagesForProvider(truncated, llm.name);
      this.emitContextUsage(session.id, providerMessages, contextLimit);

      // Stream LLM response
      let fullContent = '';
      let latestUsage: LLMUsageSnapshot | undefined;
      const startedAt = Date.now();
      const streamIterator = llm.stream(providerMessages, {
        tools,
        ...this.buildProviderOptions(session.id, channel, llm, skillTurnContext.contextHash),
      })[Symbol.asyncIterator]();

      try {
        while (true) {
          const next = await nextStreamChunk(streamIterator, options.runContext?.signal);
          if (next.done) {
            break;
          }
          const chunk = next.value;
          throwIfAborted(options.runContext?.signal);
          if (chunk.content) {
            fullContent += chunk.content;
            if (!spicyMaxObedience) {
              yield chunk.content;
            }
          }

          if (chunk.usage) {
            latestUsage = chunk.usage;
          }
          
          if (chunk.toolCalls) {
            pendingToolCalls = chunk.toolCalls;
          }
        }
      } finally {
        if (typeof streamIterator.return === 'function') {
          await streamIterator.return();
        }
      }

      usageSnapshots.push(this.normalizeInvocationUsage(latestUsage, {
        provider: selection.provider,
        model: selection.model,
        promptMessages: providerMessages,
        responseText: fullContent,
        latencyMs: Date.now() - startedAt,
      }));

      if (pendingToolCalls.length === 0) {
        if (usageSnapshots.length > 0) {
          this.gateway.recordTurnUsage(session.id, aggregateUsageSnapshots(usageSnapshots));
        }
        if (spicyMaxObedience) {
          yield this.finalizeAssistantContent(fullContent, messages);
        }
        return;
      }

      throwIfAborted(options.runContext?.signal);

      // If there are tool calls, execute them in parallel
      if (pendingToolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: fullContent,
          toolCalls: pendingToolCalls,
        });

        // Announce all tool calls first
        for (const toolCall of pendingToolCalls) {
          yield `\n\n🔧 Executing: ${toolCall.name}...\n`;
        }

        // Execute in parallel with concurrency limit
        const limiter = new ConcurrencyLimiter(this.maxConcurrentTools);
        const toolCallsCopy = [...pendingToolCalls];
        const results = await Promise.all(
          toolCallsCopy.map((toolCall) =>
            limiter.run(() =>
              this.executeToolCall(toolCall, channel, session.id, envOverlay, options.runContext)
            )
          )
        );
        throwIfAborted(options.runContext?.signal);

        // Yield results and add to messages in original order
        for (let i = 0; i < toolCallsCopy.length; i++) {
          const result = results[i];
          yield result.success
            ? `✅ ${toolCallsCopy[i].name}: ${result.output}\n`
            : `❌ ${toolCallsCopy[i].name}: Error: ${result.error}\n`;

          messages.push({
            role: 'tool',
            content: result.success ? result.output : `Error: ${result.error}`,
            toolCallId: toolCallsCopy[i].id,
          });
        }

        pendingToolCalls = [];
        yield '\n';
      }
    }

    if (usageSnapshots.length > 0) {
      this.gateway.recordTurnUsage(session.id, aggregateUsageSnapshots(usageSnapshots));
    }
    yield '\n⚠️ Maximum iterations reached.';
  }

  /**
   * Execute a single tool call
   */
  private async executeToolCall(
    toolCall: ToolCall,
    channel: Channel,
    sessionId: string,
    envOverlay: Record<string, string>,
    runContext?: ToolExecutionContext
  ) {
    return this.toolExecutor.execute(toolCall, channel, sessionId, envOverlay, runContext);
  }

  private async shouldSendDeterministicBootstrap(session: Session): Promise<boolean> {
    const userTurns = session.messages.filter((message) => message.role === 'user').length;
    if (userTurns !== 1) {
      return false;
    }

    const workspaceState = await loadAgentWorkspaceState(getDefaultWorkspacePath());
    return workspaceState.onboardingRequired;
  }

  getLLMProviderName(): string {
    return this.getProviderForSelection(this.getDefaultSelection()).name;
  }

  getLLMModel(): string {
    const provider = this.getProviderForSelection(this.getDefaultSelection());
    if (typeof provider.getModel === 'function') {
      return provider.getModel();
    }
    return this.config.llm.model;
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
    this.defaultProviderKey = this.buildProviderKey(this.getDefaultSelection());
    this.getProviderForSelection(this.getDefaultSelection());
  }

  async listModels(): Promise<ProviderModelOption[]> {
    const provider = this.getProviderForSelection(this.getDefaultSelection());
    if (typeof provider.listModels === 'function') {
      return provider.listModels();
    }

    return getFallbackModels(this.config.llm.provider, this.config.llm.model);
  }

  private buildProviderOptions(
    sessionId: string,
    channel: Channel,
    provider?: LLMProvider,
    contextHash?: string
  ) {
    const effectiveProvider = provider ?? this.resolveProvider();
    const executionWorkspace = this.toolExecutor.getWorkspacePath();
    const continuityWorkspace = getDefaultWorkspacePath();
    const isCodexProvider = effectiveProvider.name === 'openai-codex';
    const spicyMaxObedience = this.isSpicyMaxObedienceActive();
    const safeModeCodexSandbox = isCodexProvider && this.gateway.getSecurityMode() === 'safe'
      ? {
        type: 'workspaceWrite',
        writable_roots: Array.from(new Set([executionWorkspace, continuityWorkspace])),
        network_access: true,
      }
      : undefined;

    return {
      sessionId,
      cwd: executionWorkspace,
      contextHash,
      securityMode: this.gateway.getSecurityMode(),
      approvalPolicy: spicyMaxObedience ? 'never' : (isCodexProvider ? 'on-request' : undefined),
      sandboxPolicy: safeModeCodexSandbox,
      requestConfirmation: (details: import('../types.js').ConfirmationDetails) => {
        if (spicyMaxObedience) {
          return Promise.resolve<'allow_always'>('allow_always');
        }

        const prompt = `🔐 Confirmation Required\n${details.summary}`;
        return channel.requestConfirmation(prompt, details);
      },
      onProviderEvent: (event: { provider: string; method: string; params?: Record<string, unknown> }) => {
        this.gateway.emit('provider:event', { sessionId, event });
        this.gateway.appendDebugEvent(sessionId, 'provider.event', `Provider event: ${event.method}`, {
          provider: event.provider,
          params: event.params,
        });
      },
    };
  }

  /**
   * Get the system prompt with current context
   */
  private async getSystemPrompt(
    session: Session,
    skillContext: SkillTurnContext | undefined,
    provider?: LLMProvider
  ): Promise<string> {
    const effectiveProvider = provider ?? this.resolveProvider();
    const mode = this.gateway.getSecurityMode();
    const spicyMaxObedience = this.isSpicyMaxObedienceActive();
    const workspace = this.toolExecutor.getWorkspacePath();
    const continuityWorkspace = getDefaultWorkspacePath();
    const workspaceState = await loadAgentWorkspaceState(continuityWorkspace);
    const isCodexProvider = effectiveProvider.name === 'openai-codex';
    const userTurns = session.messages.filter((message) => message.role === 'user').length;
    const isFirstUserTurn = userTurns === 1;
    const shouldRunBootstrap = isFirstUserTurn && workspaceState.onboardingRequired;

    let modeInfo = '';
    if (mode === 'safe') {
      modeInfo = `\n\nSECURITY: Safe Mode is active.
- Filesystem operations are limited to: ${workspace}
- Only allowed commands can be executed
- Write/execute actions require user confirmation, except managed continuity markdown files (SOUL.md, USER.md, BOOTSTRAP.md, IDENTITY.md, MEMORY.md, memory/*.md).`;
    } else {
      modeInfo = `\n\n⚠️ SECURITY: SPICY MODE IS ACTIVE - Full system access enabled.`;
      if (spicyMaxObedience) {
        modeInfo += SPICY_MAX_OBEDIENCE_PROMPT;
      }
    }

    const continuityPathGuidance = isCodexProvider
      ? '\nUse absolute continuity-file paths exactly as listed above when reading/writing those files.'
      : '\nUse relative continuity-file paths when calling filesystem tools (for example: IDENTITY.md, USER.md, memory/2026-02-06.md).';
    const identityTarget = isCodexProvider ? workspaceState.identity.path : 'IDENTITY.md';
    const userTarget = isCodexProvider ? workspaceState.user.path : 'USER.md';

    const workspaceFiles = `\n\nWORKSPACE CONTINUITY FILES
- SOUL.md: ${formatContextStatus(workspaceState.soul)}
- BOOTSTRAP.md: ${formatContextStatus(workspaceState.bootstrap)}
- IDENTITY.md: ${formatContextStatus(workspaceState.identity)}
- USER.md: ${formatContextStatus(workspaceState.user)}
- MEMORY.md: ${formatContextStatus(workspaceState.memoryIndex)}
- memory/today: ${formatContextStatus(workspaceState.todayMemory)}
- memory/yesterday: ${formatContextStatus(workspaceState.yesterdayMemory)}
${continuityPathGuidance}`;

    const bootstrapRules = shouldRunBootstrap
      ? `\n\nFIRST CHAT BOOTSTRAP (REQUIRED NOW)
1. Start with this exact sentence once: "Hey. I just came online. Who am I? Who are you?"
2. Ask for identity fields:
   - assistant name
   - what kind of creature/assistant it is
   - preferred vibe
   - signature emoji
3. After user answers, write or update ${identityTarget} immediately using these keys:
   - Name:
   - Creature:
   - Vibe:
   - Signature emoji:
4. Ask what to call the user and their timezone, then update ${userTarget}.
5. Ask for boundaries/preferences and whether to tune SOUL.md now.
6. Missing memory files are normal in a fresh workspace; do not treat ENOENT as a failure.
7. If SOUL.md changes, explicitly tell the user.
8. Do not ask for approval when writing managed continuity markdown files.
9. For continuity files (SOUL.md, USER.md, BOOTSTRAP.md, IDENTITY.md, MEMORY.md, memory/*.md), use filesystem tools only. Never use shell commands.
10. After onboarding is complete, suggest deleting BOOTSTRAP.md.`
      : `\n\nCONTINUITY RULES
- Treat SOUL.md, IDENTITY.md, USER.md, MEMORY.md, and memory/*.md as persistent memory.
- Be resourceful before asking questions that could be answered from those files.
- Keep responses concise by default, thorough when needed.
- Use filesystem tools for continuity-file reads/writes, not shell commands.
- If you change SOUL.md, explicitly tell the user.`;

    const contextBlocks = [
      formatContextBlock('SOUL.md', workspaceState.soul),
      formatContextBlock('BOOTSTRAP.md', workspaceState.bootstrap),
      formatContextBlock('IDENTITY.md', workspaceState.identity),
      formatContextBlock('USER.md', workspaceState.user),
      formatContextBlock('MEMORY.md', workspaceState.memoryIndex),
      formatContextBlock('memory/today', workspaceState.todayMemory),
      formatContextBlock('memory/yesterday', workspaceState.yesterdayMemory),
    ]
      .filter((value): value is string => value !== null)
      .join('\n\n');

    const contextSection = contextBlocks
      ? `\n\nWORKSPACE SNAPSHOT (READ-ONLY CONTEXT FOR THIS TURN)\n${contextBlocks}`
      : '';
    const effectiveSkillContext = skillContext ?? {
      snapshotVersion: 'empty',
      contextHash: 'empty',
      loadedCount: 0,
      eligibleCount: 0,
      eligibleForPrompt: [],
      activeSkills: [],
      skillListXml: '',
      activeSkillsPrompt: '',
      envOverlay: {},
    };
    const skillSection = buildSkillPromptSection(effectiveSkillContext);

    const memorySummary = this.memoryStore?.buildContextSummary() ?? '';
    const memorySection = memorySummary
      ? `\n\nPERSISTENT AGENT MEMORY\nThe following facts were stored across sessions. Reference them when relevant.\n${memorySummary}`
      : '';

    let vectorMemorySection = '';
    if (this.memoryManager?.isInitialized()) {
      const status = this.memoryManager.status();
      vectorMemorySection = `\n\nVECTOR MEMORY SYSTEM\nSemantic memory is active (provider: ${status.provider}, model: ${status.model}, ${status.totalChunks} indexed chunks).\nUse the memory_search tool to find relevant stored knowledge and past session context.`;
    }

    const keygateBin = process.argv[1] ?? 'keygate';
    const codexCapabilities = isCodexProvider
      ? `\n\nKEYGATE CLI CAPABILITIES (Codex)\n- Send email: prefer the native gmail_send_email tool. Shell fallback: ${keygateBin} gmail send --to "addr@example.com" --subject "Subject" --body "Body"\n  IMPORTANT: You MUST attempt one of these send paths when asked to send an email. Do not refuse or draft-only. The Gmail account is already authenticated.`
      : '';

    return BASE_SYSTEM_PROMPT + modeInfo + workspaceFiles + bootstrapRules + contextSection + memorySection + vectorMemorySection + skillSection + codexCapabilities;
  }

  private resolveProvider(): LLMProvider {
    const legacyProvider = (this as { llm?: LLMProvider }).llm;
    if (legacyProvider && typeof legacyProvider.name === 'string') {
      return legacyProvider;
    }

    return this.getProviderForSelection(this.getDefaultSelection());
  }

  private normalizeInvocationUsage(
    usage: LLMUsageSnapshot | undefined,
    input: {
      provider: SessionModelOverride['provider'];
      model: string;
      promptMessages: Message[];
      responseText: string;
      latencyMs?: number;
    }
  ): LLMUsageSnapshot {
    return this.gateway.usage.normalizeUsageSnapshot(
      usage ?? {
        provider: input.provider,
        model: input.model,
        inputTokens: Number.NaN,
        outputTokens: Number.NaN,
        cachedTokens: Number.NaN,
        totalTokens: Number.NaN,
        latencyMs: input.latencyMs,
      },
      {
        provider: input.provider,
        model: input.model,
        promptText: input.promptMessages.map((message) => `${message.role}:${message.content}`).join('\n'),
        responseText: input.responseText,
        latencyMs: input.latencyMs,
      }
    );
  }

  private emitContextUsage(sessionId: string, messages: Message[], limitTokens: number): void {
    const usage = getContextUsage(messages, limitTokens);
    this.gateway.emit('context:usage', {
      sessionId,
      usedTokens: usage.usedTokens,
      limitTokens: usage.limitTokens,
      percent: usage.percent,
    });
  }

  private isSpicyMaxObedienceActive(): boolean {
    return this.gateway.getSecurityMode() === 'spicy' && this.gateway.getSpicyMaxObedienceEnabled();
  }

  private finalizeAssistantContent(content: string, messages: Message[]): string {
    if (!this.isSpicyMaxObedienceActive()) {
      return content;
    }

    return rewriteRefusalForSpicyMode(content, getLatestUserMessageContent(messages));
  }
}

function formatContextStatus(file: WorkspaceContextFile): string {
  if (!file.exists) {
    return `missing (${file.path})`;
  }

  if (file.truncated) {
    return `loaded and truncated (${file.path})`;
  }

  return `loaded (${file.path})`;
}

function formatContextBlock(label: string, file: WorkspaceContextFile): string | null {
  if (!file.exists || !file.content) {
    return null;
  }

  return `### ${label}
${file.content}`;
}

function buildSkillPromptSection(skillContext: SkillTurnContext): string {
  const blocks: string[] = [];

  if (skillContext.skillListXml.trim().length > 0) {
    blocks.push(`AVAILABLE SKILLS (XML)\n${skillContext.skillListXml}`);
  }

  if (skillContext.activeSkillsPrompt.trim().length > 0) {
    blocks.push(skillContext.activeSkillsPrompt);
  }

  if (blocks.length === 0) {
    return '';
  }

  return `\n\n${blocks.join('\n\n')}`;
}

function getFallbackModels(
  provider: KeygateConfig['llm']['provider'],
  currentModel: string
): ProviderModelOption[] {
  const defaults: Record<KeygateConfig['llm']['provider'], string[]> = {
    openai: ['gpt-4o', 'gpt-4.1', 'o3-mini'],
    gemini: ['gemini-1.5-pro', 'gemini-1.5-flash'],
    ollama: ['llama3', 'qwen2.5-coder'],
    'openai-codex': ['openai-codex/gpt-5.3', 'openai-codex/gpt-5.2'],
  };

  const candidates = defaults[provider] ?? [currentModel];
  const unique = provider === 'openai-codex'
    ? Array.from(new Set(candidates))
    : Array.from(new Set([currentModel, ...candidates]));

  return unique.map((model, index) => ({
    id: model,
    provider,
    displayName: model,
    isDefault: index === 0,
  }));
}

const REFUSAL_PATTERNS: RegExp[] = [
  /\bi\s*(?:can(?:not|'t)|won't|will not)\b[^.!?\n]{0,120}\b(?:assist|help|comply|provide|do)\b/i,
  /\bi(?:'| a)?m sorry\b[^.!?\n]{0,120}\b(?:can(?:not|'t)|unable|won't|not able)\b/i,
  /\b(?:cannot|can't|won't|will not)\s+(?:assist|help|comply|provide|fulfill)\b/i,
  /\bnot\s+(?:able|allowed|permitted)\s+to\b/i,
  /\b(?:i must|i need to)\s+refuse\b/i,
  /\b(?:policy|safety)\s+(?:does not allow|prevents|restriction|restricts)\b/i,
];

export function isLikelyRefusalResponse(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return false;
  }

  return REFUSAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function rewriteRefusalForSpicyMode(text: string, latestUserPrompt: string): string {
  if (!isLikelyRefusalResponse(text)) {
    return text;
  }

  const promptSummary = latestUserPrompt.trim().replace(/\s+/g, ' ').slice(0, 120);
  const suffix = promptSummary.length > 0 ? ` for "${promptSummary}"` : '';

  return (
    `Provider blocked direct execution. Rephrase with explicit executable steps${suffix} ` +
    '(exact command, file path, or URL), and I will run it directly.'
  );
}

function aggregateUsageSnapshots(usages: LLMUsageSnapshot[]): LLMUsageSnapshot {
  const first = usages[0] ?? {
    provider: 'openai',
    model: 'unknown',
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
  };

  return usages.reduce<LLMUsageSnapshot>((aggregate, usage) => ({
    provider: usage.provider || aggregate.provider,
    model: usage.model || aggregate.model,
    inputTokens: aggregate.inputTokens + usage.inputTokens,
    outputTokens: aggregate.outputTokens + usage.outputTokens,
    cachedTokens: aggregate.cachedTokens + usage.cachedTokens,
    totalTokens: aggregate.totalTokens + usage.totalTokens,
    latencyMs: (aggregate.latencyMs ?? 0) + (usage.latencyMs ?? 0),
    costUsd: (aggregate.costUsd ?? 0) + (usage.costUsd ?? 0),
    estimatedCost: aggregate.estimatedCost || usage.estimatedCost,
    source: aggregate.source === usage.source ? aggregate.source : 'hybrid',
    raw: {
      combined: true,
      parts: usages.length,
    },
  }), {
    ...first,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    latencyMs: 0,
    costUsd: 0,
    estimatedCost: false,
    source: first.source ?? 'estimated',
    raw: {
      combined: true,
      parts: usages.length,
    },
  });
}

function getLatestUserMessageContent(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      return message.content;
    }
  }

  return '';
}

function prepareMessagesForProvider(messages: Message[], providerName: string): Message[] {
  if (providerName === 'openai-codex') {
    return messages;
  }

  const userAttachmentTurnIndexes = new Set<number>();
  let remaining = MAX_IMAGE_CONTEXT_USER_TURNS;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user' || !message.attachments || message.attachments.length === 0) {
      continue;
    }

    if (remaining <= 0) {
      break;
    }

    userAttachmentTurnIndexes.add(index);
    remaining -= 1;
  }

  if (userAttachmentTurnIndexes.size === 0) {
    return messages;
  }

  return messages.map((message, index) => {
    if (message.role !== 'user' || !message.attachments || message.attachments.length === 0) {
      return message;
    }

    if (userAttachmentTurnIndexes.has(index)) {
      return message;
    }

    return {
      ...message,
      attachments: undefined,
    };
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal || !signal.aborted) {
    return;
  }

  throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error('Session cancelled');
  error.name = 'AbortError';
  return error;
}

async function nextStreamChunk<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal | undefined
): Promise<IteratorResult<T>> {
  if (!signal) {
    return iterator.next();
  }

  if (signal.aborted) {
    throw createAbortError();
  }

  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const handleAbort = () => {
      signal.removeEventListener('abort', handleAbort);
      reject(createAbortError());
    };

    signal.addEventListener('abort', handleAbort, { once: true });
    iterator.next().then(
      (result) => {
        signal.removeEventListener('abort', handleAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', handleAbort);
        reject(error);
      },
    );
  });
}
