// Core types for Keygate

export type SecurityMode = 'safe' | 'spicy';
export type ChannelType = 'web' | 'discord' | 'terminal' | 'slack' | 'whatsapp';
export type LLMProviderName = 'openai' | 'gemini' | 'ollama' | 'openai-codex';
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type BrowserDomainPolicy = 'none' | 'allowlist' | 'blocklist';
export type DmPolicy = 'pairing' | 'open' | 'closed';
export type WhatsAppGroupMode = 'closed' | 'selected' | 'open';
export type SkillSourceType = 'workspace' | 'global' | 'plugin' | 'bundled' | 'extra';
export type SessionCancelReason = 'user' | 'disconnect';
export type NodeManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export type SandboxScope = 'session' | 'agent';
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

export interface ToolExecutionContext {
  signal: AbortSignal;
  registerAbortCleanup: (cleanup: () => void | Promise<void>) => void;
}

export type ToolHandler = (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolResult>;

export interface Tool extends ToolDefinition {
  handler: ToolHandler;
}

// ==================== LLM ====================

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  usage?: LLMUsageSnapshot;
}

export interface LLMChunk {
  content?: string;
  toolCalls?: ToolCall[];
  done: boolean;
  usage?: LLMUsageSnapshot;
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

export interface LLMPricingOverride {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cachedInputPerMillionUsd?: number;
}

export interface LLMUsageSnapshot {
  provider: LLMProviderName | string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  latencyMs?: number;
  costUsd?: number;
  estimatedCost?: boolean;
  source?: 'native' | 'estimated' | 'hybrid';
  raw?: Record<string, unknown>;
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

export interface SessionModelOverride {
  provider: LLMProviderName;
  model: string;
  reasoningEffort?: CodexReasoningEffort;
}

export interface SessionUsageAggregate {
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number;
  lastTurnAt?: string;
}

export interface SessionDebugEvent {
  id: string;
  timestamp: string;
  type: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface Session {
  id: string;
  channelType: ChannelType;
  title?: string;
  messages: Message[];
  modelOverride?: SessionModelOverride;
  debugMode?: boolean;
  compactionSummaryRef?: string;
  usage?: SessionUsageAggregate;
  createdAt: Date;
  updatedAt: Date;
}

// ==================== Config ====================

export interface KeygateConfig {
  llm: {
    provider: LLMProviderName;
    model: string;
    reasoningEffort?: CodexReasoningEffort;
    apiKey: string;
    ollama?: {
        host: string;
    };
    pricing?: {
      overrides?: Record<string, LLMPricingOverride>;
    };
  };
  security: {
    mode: SecurityMode;
    spicyModeEnabled: boolean;
    spicyMaxObedienceEnabled?: boolean;
    workspacePath: string;
    allowedBinaries: string[];
    sandbox: {
      backend: 'docker';
      scope: SandboxScope;
      image: string;
      networkAccess: boolean;
      degradeWithoutDocker: boolean;
    };
  };
  server: {
    port: number;
    apiToken: string;
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
      nodeManager: NodeManager;
    };
  };
  plugins?: {
    load: {
      watch: boolean;
      watchDebounceMs: number;
      paths: string[];
    };
    entries: Record<string, PluginEntryConfig>;
    install: {
      nodeManager: NodeManager;
    };
  };
  discord?: {
    token: string;
    prefix: string;
    dmPolicy?: DmPolicy;
    allowFrom?: string[];
  };
  slack?: {
    botToken: string;
    appToken: string;
    signingSecret: string;
    dmPolicy?: DmPolicy;
    allowFrom?: string[];
  };
  whatsapp?: WhatsAppConfig;
  gmail?: GmailConfig;
  memory?: {
    provider: 'auto' | 'openai' | 'codex' | 'gemini' | 'ollama';
    model?: string;
    vectorWeight: number;
    textWeight: number;
    maxResults: number;
    minScore: number;
    autoIndex: boolean;
    indexSessions: boolean;
    temporalDecay: boolean;
    temporalHalfLifeDays: number;
    mmr: boolean;
  };
}

export interface GmailDefaultsConfig {
  projectId?: string;
  pubsubTopic?: string;
  pushBaseUrl?: string;
  pushPathSecret?: string;
  targetSessionId?: string;
  labelIds?: string[];
  promptPrefix?: string;
  watchRenewalMinutes?: number;
}

export interface GmailConfig {
  clientId?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  redirectUri?: string;
  redirectPort?: number;
  defaults: GmailDefaultsConfig;
}

export interface WhatsAppGroupRule {
  requireMention?: boolean;
  name?: string;
}

export interface WhatsAppConfig {
  dmPolicy: DmPolicy;
  allowFrom: string[];
  groupMode: WhatsAppGroupMode;
  groups: Record<string, WhatsAppGroupRule>;
  groupRequireMentionDefault: boolean;
  sendReadReceipts: boolean;
}

export interface SkillEntryConfig {
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
}

export interface PluginEntryConfig {
  enabled?: boolean;
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
  'context:usage': {
    sessionId: string;
    usedTokens: number;
    limitTokens: number;
    percent: number;
  };
  'usage:snapshot': {
    sessionId: string;
    usage: LLMUsageSnapshot;
    aggregate: SessionUsageAggregate;
  };
  'session:compacted': {
    sessionId: string;
    compactionSummaryRef: string;
    summary: string;
  };
  'debug:event': {
    sessionId: string;
    event: SessionDebugEvent;
  };
  'node:status_changed': {
    nodeId: string;
    online: boolean;
    lastSeenAt: string;
  };
  'mode:changed': { mode: SecurityMode };
  'spicy_enabled:changed': { enabled: boolean };
  'spicy_obedience:changed': { enabled: boolean };
  'session:cancelled': { sessionId: string; reason: SessionCancelReason };
  'confirm:request': {
    sessionId: string;
    prompt: string;
    details?: ConfirmationDetails;
    resolve: (decision: ConfirmationDecision) => void;
  };
}
