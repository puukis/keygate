// Core types for Keygate

export type SecurityMode = 'safe' | 'spicy';
export type ChannelType = 'web' | 'discord';
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

// ==================== Messages ====================

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  url?: string;
  data?: Buffer;
}

export interface NormalizedMessage {
  id: string;
  sessionId: string;
  channelType: ChannelType;
  channel: Channel;
  userId: string;
  content: string;
  attachments?: Attachment[];
  timestamp: Date;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

// ==================== Channels ====================

export interface Channel {
  type: ChannelType;
  send(content: string): Promise<void>;
  sendStream(stream: AsyncIterable<string>): Promise<void>;
  requestConfirmation(prompt: string, details?: ConfirmationDetails): Promise<ConfirmationDecision>;
}

export type ConfirmationDecision = 'allow_once' | 'allow_always' | 'cancel';

export interface ConfirmationDetails {
  tool: string;
  action: string;
  summary: string;
  command?: string;
  cwd?: string;
  path?: string;
  args?: Record<string, unknown>;
}

// ==================== Tools ====================

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  requiresConfirmation: boolean;
  type: 'filesystem' | 'shell' | 'sandbox' | 'search' | 'browser' | 'other';
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export interface Tool extends ToolDefinition {
  handler: ToolHandler;
}

// ==================== LLM ====================

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

export interface LLMChunk {
  content?: string;
  toolCalls?: ToolCall[];
  done: boolean;
}

export interface ChatOptions {
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  sessionId?: string;
  cwd?: string;
  securityMode?: SecurityMode;
  approvalPolicy?: string;
  sandboxPolicy?: Record<string, unknown>;
  requestConfirmation?: (details: ConfirmationDetails) => Promise<ConfirmationDecision>;
  onProviderEvent?: (event: ProviderEvent) => void;
}

export interface ProviderEvent {
  provider: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface ProviderModelOption {
  id: string;
  provider: string;
  displayName: string;
  isDefault?: boolean;
  supportsPersonality?: boolean;
  reasoningEffort?: unknown;
  defaultReasoningEffort?: CodexReasoningEffort;
  metadata?: Record<string, unknown>;
}

export interface LLMProvider {
  name: string;
  chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse>;
  stream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk>;
  listModels?(): Promise<ProviderModelOption[]>;
  setModel?(model: string): void | Promise<void>;
  getModel?(): string;
  login?(options?: Record<string, unknown>): Promise<void>;
  dispose?(): void | Promise<void>;
}

// ==================== Sessions ====================

export interface Session {
  id: string;
  channelType: ChannelType;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
}

// ==================== Config ====================

export interface KeygateConfig {
  llm: {
    provider: 'openai' | 'gemini' | 'ollama' | 'openai-codex';
    model: string;
    reasoningEffort?: CodexReasoningEffort;
    apiKey: string;
    ollama?: {
        host: string;
    }
  };
  security: {
    mode: SecurityMode;
    spicyModeEnabled: boolean;
    workspacePath: string;
    allowedBinaries: string[];
  };
  server: {
    port: number;
  };
  discord?: {
    token: string;
    prefix: string;
  };
}

// ==================== Events ====================

export interface KeygateEvents {
  'message:start': { sessionId: string; messageId: string };
  'message:chunk': { sessionId: string; content: string };
  'message:end': { sessionId: string; content: string };
  'tool:start': { sessionId: string; tool: string; args: Record<string, unknown> };
  'tool:end': { sessionId: string; tool: string; result: ToolResult };
  'provider:event': { sessionId: string; event: ProviderEvent };
  'mode:changed': { mode: SecurityMode };
  'confirm:request': {
    sessionId: string;
    prompt: string;
    details?: ConfirmationDetails;
    resolve: (decision: ConfirmationDecision) => void;
  };
}
