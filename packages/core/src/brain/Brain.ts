import type {
  Channel,
  CodexReasoningEffort,
  KeygateConfig,
  LLMProvider,
  Message,
  ProviderModelOption,
  Session,
  ToolCall,
} from '../types.js';
import type { ToolExecutor } from '../tools/ToolExecutor.js';
import type { Gateway } from '../gateway/Gateway.js';
import { createLLMProvider } from '../llm/index.js';

const SYSTEM_PROMPT = `You are Keygate, a helpful AI assistant that can control the user's computer and online services.

You have access to various tools to help accomplish tasks:
- Filesystem operations (read, write, list files)
- Shell commands (run terminal commands)
- Code execution (run JavaScript/Python code in a sandbox)
- Web search (search the internet for information)
- Browser automation (navigate, click, screenshot)

When helping the user:
1. Think step by step about what needs to be done
2. Use tools when necessary to gather information or take actions
3. Be clear about what actions you're taking
4. Report results and any errors encountered

Current security mode will affect what operations are allowed.`;

/**
 * Brain - The ReAct agent loop
 * 
 * Implements: Reason → Tool → Observe → Respond
 * Continues calling tools until LLM generates a final response
 */
export class Brain {
  private llm: LLMProvider;
  private config: KeygateConfig;
  private toolExecutor: ToolExecutor;
  private gateway: Gateway;
  private maxIterations = 10;

  constructor(config: KeygateConfig, toolExecutor: ToolExecutor, gateway: Gateway) {
    this.config = config;
    this.llm = createLLMProvider(config);
    this.toolExecutor = toolExecutor;
    this.gateway = gateway;
  }

  /**
   * Run the agent loop for a session
   */
  async run(session: Session, channel: Channel): Promise<string> {
    // Build messages with system prompt
    const messages: Message[] = [
      { role: 'system', content: this.getSystemPrompt() },
      ...session.messages,
    ];

    // Get tool definitions
    const tools = this.toolExecutor.getToolDefinitions();

    let iterations = 0;

    while (iterations < this.maxIterations) {
      iterations++;

      // Call LLM with tools
      const response = await this.llm.chat(messages, {
        tools,
        ...this.buildProviderOptions(session.id),
      });

      // If no tool calls, return the response content
      if (!response.toolCalls || response.toolCalls.length === 0) {
        return response.content;
      }

      // Add assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      });

      // Execute each tool call
      for (const toolCall of response.toolCalls) {
        const result = await this.executeToolCall(toolCall, channel);
        
        // Add tool result to messages
        messages.push({
          role: 'tool',
          content: result.success 
            ? result.output 
            : `Error: ${result.error}`,
          toolCallId: toolCall.id,
        });
      }
    }

    return 'Maximum iterations reached. Please try breaking down your request into smaller steps.';
  }

  /**
   * Run the agent loop with streaming response
   */
  async *runStream(session: Session, channel: Channel): AsyncIterable<string> {
    const messages: Message[] = [
      { role: 'system', content: this.getSystemPrompt() },
      ...session.messages,
    ];

    const tools = this.toolExecutor.getToolDefinitions();
    let iterations = 0;
    let pendingToolCalls: ToolCall[] = [];

    while (iterations < this.maxIterations) {
      iterations++;

      // Stream LLM response
      let fullContent = '';
      
      for await (const chunk of this.llm.stream(messages, {
        tools,
        ...this.buildProviderOptions(session.id),
      })) {
        if (chunk.content) {
          fullContent += chunk.content;
          yield chunk.content;
        }
        
        if (chunk.toolCalls) {
          pendingToolCalls = chunk.toolCalls;
        }

        if (chunk.done && pendingToolCalls.length === 0) {
          return;
        }
      }

      // If there are tool calls, execute them
      if (pendingToolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: fullContent,
          toolCalls: pendingToolCalls,
        });

        for (const toolCall of pendingToolCalls) {
          yield `\n\n🔧 Executing: ${toolCall.name}...\n`;
          
          const result = await this.executeToolCall(toolCall, channel);
          
          yield result.success 
            ? `✅ ${result.output}\n`
            : `❌ Error: ${result.error}\n`;

          messages.push({
            role: 'tool',
            content: result.success ? result.output : `Error: ${result.error}`,
            toolCallId: toolCall.id,
          });
        }

        pendingToolCalls = [];
        yield '\n';
      }
    }

    yield '\n⚠️ Maximum iterations reached.';
  }

  /**
   * Execute a single tool call
   */
  private async executeToolCall(toolCall: ToolCall, channel: Channel) {
    return this.toolExecutor.execute(toolCall, channel);
  }

  getLLMProviderName(): string {
    return this.llm.name;
  }

  getLLMModel(): string {
    if (typeof this.llm.getModel === 'function') {
      return this.llm.getModel();
    }
    return this.config.llm.model;
  }

  async setLLMSelection(
    provider: KeygateConfig['llm']['provider'],
    model: string,
    reasoningEffort?: CodexReasoningEffort
  ): Promise<void> {
    const previousProvider = this.llm;

    this.config.llm.provider = provider;
    this.config.llm.model = model;
    if (provider === 'openai-codex') {
      this.config.llm.reasoningEffort = reasoningEffort ?? this.config.llm.reasoningEffort ?? 'medium';
    }

    this.llm = createLLMProvider(this.config);

    if (typeof previousProvider.dispose === 'function') {
      await previousProvider.dispose();
    }
  }

  async listModels(): Promise<ProviderModelOption[]> {
    if (typeof this.llm.listModels === 'function') {
      return this.llm.listModels();
    }

    return getFallbackModels(this.config.llm.provider, this.config.llm.model);
  }

  private buildProviderOptions(sessionId: string) {
    return {
      sessionId,
      cwd: this.toolExecutor.getWorkspacePath(),
      securityMode: this.gateway.getSecurityMode(),
      onProviderEvent: (event: { provider: string; method: string; params?: Record<string, unknown> }) => {
        this.gateway.emit('provider:event', { sessionId, event });
      },
    };
  }

  /**
   * Get the system prompt with current context
   */
  private getSystemPrompt(): string {
    const mode = this.gateway.getSecurityMode();
    const workspace = this.toolExecutor.getWorkspacePath();
    
    let modeInfo = '';
    if (mode === 'safe') {
      modeInfo = `\n\nSECURITY: Safe Mode is active.
- Filesystem operations are limited to: ${workspace}
- Only allowed commands can be executed
- Write/execute actions require user confirmation`;
    } else {
      modeInfo = `\n\n⚠️ SECURITY: SPICY MODE IS ACTIVE - Full system access enabled.`;
    }

    return SYSTEM_PROMPT + modeInfo;
  }
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
