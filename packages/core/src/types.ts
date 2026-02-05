// Core types for Keygate

export type SecurityMode = 'safe' | 'spicy';
export type ChannelType = 'web' | 'discord';

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
  requestConfirmation(prompt: string): Promise<boolean>;
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
}

export interface LLMProvider {
  name: string;
  chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse>;
  stream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk>;
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
    provider: 'openai' | 'gemini' | 'ollama';
    model: string;
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
  'mode:changed': { mode: SecurityMode };
  'confirm:request': { sessionId: string; prompt: string; resolve: (confirmed: boolean) => void };
}
