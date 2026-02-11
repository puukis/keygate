// Core types for Keygate

export type SecurityMode = 'safe' | 'spicy';
export type ChannelType = 'web' | 'discord' | 'terminal';
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type BrowserDomainPolicy = 'none' | 'allowlist' | 'blocklist';
export type SkillSourceType = 'workspace' | 'global' | 'plugin' | 'bundled' | 'extra';
export type SkillEligibilityReason =
  | 'eligible'
  | 'disabled'
  | 'bundled_not_allowed'
  | 'os_mismatch'
  | 'missing_bins'
  | 'missing_any_bins'
  | 'missing_env'
  | 'missing_config';
export type SkillCommandDispatch = 'tool';
export type SkillCommandArgMode = 'raw';

// ==================== Messages ====================

export interface MessageAttachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  path: string;
  url: string;
}

export interface NormalizedMessage {
  id: string;
  sessionId: string;
  channelType: ChannelType;
  channel: Channel;
  userId: string;
  content: string;
  attachments?: MessageAttachment[];
  timestamp: Date;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  attachments?: MessageAttachment[];
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
  contextHash?: string;
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
    spicyMaxObedienceEnabled?: boolean;
    workspacePath: string;
    allowedBinaries: string[];
  };
  server: {
    port: number;
  };
  browser: {
    domainPolicy: BrowserDomainPolicy;
    domainAllowlist: string[];
    domainBlocklist: string[];
    traceRetentionDays: number;
    mcpPlaywrightVersion: string;
    artifactsPath: string;
  };
  skills?: {
    load: {
      watch: boolean;
      watchDebounceMs: number;
      extraDirs: string[];
      pluginDirs: string[];
    };
    entries: Record<string, SkillEntryConfig>;
    allowBundled?: string[];
    install: {
      nodeManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
    };
  };
  discord?: {
    token: string;
    prefix: string;
  };
}

export interface SkillEntryConfig {
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
}

export interface SkillMetadataKeygate {
  always?: boolean;
  emoji?: string;
  homepage?: string;
  os?: Array<'darwin' | 'linux' | 'win32'>;
  requires?: {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
  };
  primaryEnv?: string;
  install?: Array<Record<string, unknown>>;
  skillKey?: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  homepage?: string;
  ['user-invocable']?: boolean;
  ['disable-model-invocation']?: boolean;
  ['command-dispatch']?: SkillCommandDispatch;
  ['command-tool']?: string;
  ['command-arg-mode']?: SkillCommandArgMode;
  metadata?: string;
}

export interface SkillDefinition {
  name: string;
  description: string;
  location: string;
  sourceType: SkillSourceType;
  body: string;
  homepage?: string;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  commandDispatch?: SkillCommandDispatch;
  commandTool?: string;
  commandArgMode: SkillCommandArgMode;
  metadata?: SkillMetadataKeygate;
}

export interface SkillRuntimeEntry {
  skill: SkillDefinition;
  eligible: boolean;
  reason: SkillEligibilityReason;
  envOverlay: Record<string, string>;
}

export interface SkillRuntimeSnapshot {
  snapshotVersion: string;
  loaded: SkillDefinition[];
  entries: SkillRuntimeEntry[];
  eligible: SkillDefinition[];
}

// ==================== Events ====================

export interface KeygateEvents {
  'message:user': {
    sessionId: string;
    channelType: ChannelType;
    content: string;
    attachments?: MessageAttachment[];
  };
  'message:start': { sessionId: string; messageId: string };
  'message:chunk': { sessionId: string; content: string };
  'message:end': { sessionId: string; content: string };
  'tool:start': { sessionId: string; tool: string; args: Record<string, unknown> };
  'tool:end': { sessionId: string; tool: string; result: ToolResult };
  'provider:event': { sessionId: string; event: ProviderEvent };
  'mode:changed': { mode: SecurityMode };
  'spicy_enabled:changed': { enabled: boolean };
  'spicy_obedience:changed': { enabled: boolean };
  'confirm:request': {
    sessionId: string;
    prompt: string;
    details?: ConfirmationDetails;
    resolve: (decision: ConfirmationDecision) => void;
  };
}
