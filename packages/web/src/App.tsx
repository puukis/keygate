import { useState, useCallback, useEffect, useMemo } from 'react';
import { ChatView } from './components/ChatView';
import { LiveActivityLog } from './components/LiveActivityLog';
import { SecurityBadge } from './components/SecurityBadge';
import { ConfirmationModal } from './components/ConfirmationModal';
import { useWebSocket } from './hooks/useWebSocket';
import { buildEnableSpicyModeMessage, buildSetSpicyObedienceMessage } from './spicyObedience';
import {
  buildLatestScreenshotUrl,
  shouldResetLatestScreenshotPreview,
} from './browserPreview';
import {
  EMPTY_SESSION_CHAT_STATE,
  buildSessionOptions,
  isComposerDisabled,
  isSessionReadOnly,
  reduceSessionChatState,
  type SessionChannelType,
  type SessionSnapshotEntry,
} from './sessionView';
import './App.css';

export type SecurityMode = 'safe' | 'spicy';
export type LLMProviderId = 'openai' | 'gemini' | 'ollama' | 'openai-codex';
type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
type ConfirmationDecision = 'allow_once' | 'allow_always' | 'cancel';
type BrowserDomainPolicy = 'none' | 'allowlist' | 'blocklist';

interface BrowserConfigState {
  installed: boolean;
  healthy: boolean;
  serverName: string;
  configuredVersion: string | null;
  desiredVersion: string;
  domainPolicy: BrowserDomainPolicy;
  domainAllowlist: string[];
  domainBlocklist: string[];
  traceRetentionDays: number;
  artifactsPath: string;
  command: string | null;
  args: string[];
  warning?: string;
}

interface LatestScreenshotPreview {
  sessionId: string;
  imageUrl: string;
  capturedAt: Date | null;
}

interface DiscordConfigState {
  configured: boolean;
  prefix: string;
}

interface LLMState {
  provider: LLMProviderId;
  model: string;
  reasoningEffort?: CodexReasoningEffort;
}

export interface ProviderModelOption {
  id: string;
  provider: LLMProviderId;
  displayName: string;
  isDefault?: boolean;
  supportsPersonality?: boolean;
  reasoningEffort?: unknown;
  defaultReasoningEffort?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface ToolEvent {
  id: string;
  type: 'start' | 'end' | 'provider';
  tool: string;
  args?: Record<string, unknown>;
  result?: { success: boolean; output: string; error?: string };
  detail?: string;
  important?: boolean;
  timestamp: Date;
}

export interface PendingConfirmation {
  id: string;
  prompt: string;
  details?: ConfirmationDetails;
  sessionId: string;
}

interface ConfirmationDetails {
  tool: string;
  action: string;
  summary: string;
  command?: string;
  cwd?: string;
  path?: string;
  args?: Record<string, unknown>;
}

export interface StreamActivity {
  id: string;
  source: 'system' | 'tool' | 'provider';
  status: string;
  detail?: string;
  timestamp: Date;
}

type StreamActivityDraft = Omit<StreamActivity, 'id' | 'timestamp'>;

function getWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

const PROVIDER_OPTIONS: Array<{ value: LLMProviderId; label: string }> = [
  { value: 'openai', label: 'OpenAI API' },
  { value: 'openai-codex', label: 'OpenAI Codex (ChatGPT OAuth)' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'ollama', label: 'Ollama (Local)' },
];

const CODEX_REASONING_EFFORT_OPTIONS: Array<{ value: CodexReasoningEffort; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
];

const DEFAULT_DISCORD_PREFIX = '!keygate ';
const DEFAULT_BROWSER_VERSION = '0.0.64';
const MAX_STREAM_ACTIVITIES = 8;

const BROWSER_DOMAIN_POLICY_OPTIONS: Array<{ value: BrowserDomainPolicy; label: string }> = [
  { value: 'none', label: 'No domain restrictions' },
  { value: 'allowlist', label: 'Allowlist only' },
  { value: 'blocklist', label: 'Blocklist deny' },
];

const DEFAULT_BROWSER_CONFIG_STATE: BrowserConfigState = {
  installed: false,
  healthy: false,
  serverName: 'playwright',
  configuredVersion: null,
  desiredVersion: DEFAULT_BROWSER_VERSION,
  domainPolicy: 'none',
  domainAllowlist: [],
  domainBlocklist: [],
  traceRetentionDays: 7,
  artifactsPath: '',
  command: null,
  args: [],
};

const PROVIDER_ACTIVITY_IGNORED_PATTERNS: RegExp[] = [
  /ratelimits/i,
  /tokenusage/i,
  /token_count/i,
  /reasoning_content_delta/i,
  /summarytextdelta/i,
  /agent_reasoning_delta/i,
];

function normalizeReasoningEffort(value: unknown): CodexReasoningEffort | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return normalized;
    case 'extra-high':
    case 'extra_high':
    case 'extra high':
      return 'xhigh';
    default:
      return undefined;
  }
}

function getReasoningOptionsForModel(model?: ProviderModelOption): CodexReasoningEffort[] {
  const modelOptions = Array.isArray(model?.reasoningEffort)
    ? model.reasoningEffort
      .map((value) => normalizeReasoningEffort(value))
      .filter((value): value is CodexReasoningEffort => value !== undefined)
    : [];

  const unique = Array.from(new Set(modelOptions));
  if (unique.length > 0) {
    return unique;
  }

  return CODEX_REASONING_EFFORT_OPTIONS.map((option) => option.value);
}

function pickReasoningEffort(
  model: ProviderModelOption | undefined,
  currentReasoningEffort: unknown
): CodexReasoningEffort {
  const available = getReasoningOptionsForModel(model);
  const normalizedCurrent = normalizeReasoningEffort(currentReasoningEffort);
  if (normalizedCurrent && available.includes(normalizedCurrent)) {
    return normalizedCurrent;
  }

  const normalizedDefault = normalizeReasoningEffort(model?.defaultReasoningEffort);
  if (normalizedDefault && available.includes(normalizedDefault)) {
    return normalizedDefault;
  }

  return available[0] ?? 'medium';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = normalizeWhitespace(value);
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

function firstRawString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      return value;
    }
  }

  return undefined;
}

function firstNonEmptyRawString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    if (value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}

function parseDiscordConfig(value: unknown): DiscordConfigState | undefined {
  const payload = asRecord(value);
  if (!payload) {
    return undefined;
  }

  const configured = payload['configured'] === true;
  const rawPrefix = typeof payload['prefix'] === 'string'
    ? payload['prefix']
    : DEFAULT_DISCORD_PREFIX;

  return {
    configured,
    prefix: normalizeDiscordPrefixInput(rawPrefix, true),
  };
}

function parseBrowserConfig(value: unknown): BrowserConfigState | undefined {
  const payload = asRecord(value);
  if (!payload) {
    return undefined;
  }

  const domainPolicyRaw = firstString(payload['domainPolicy'])?.toLowerCase();
  const domainPolicy: BrowserDomainPolicy =
    domainPolicyRaw === 'allowlist' || domainPolicyRaw === 'blocklist'
      ? domainPolicyRaw
      : 'none';

  const configuredVersion = firstString(payload['configuredVersion']) ?? null;
  const desiredVersion = firstString(payload['desiredVersion']) ?? DEFAULT_BROWSER_VERSION;
  const traceRetentionDaysRaw = Number.parseInt(String(payload['traceRetentionDays'] ?? ''), 10);
  const traceRetentionDays = Number.isFinite(traceRetentionDaysRaw) && traceRetentionDaysRaw > 0
    ? traceRetentionDaysRaw
    : 7;

  return {
    installed: payload['installed'] === true,
    healthy: payload['healthy'] === true,
    serverName: firstString(payload['serverName']) ?? 'playwright',
    configuredVersion,
    desiredVersion,
    domainPolicy,
    domainAllowlist: parseOriginListInput(payload['domainAllowlist']),
    domainBlocklist: parseOriginListInput(payload['domainBlocklist']),
    traceRetentionDays,
    artifactsPath: firstString(payload['artifactsPath']) ?? '',
    command: firstString(payload['command']) ?? null,
    args: Array.isArray(payload['args'])
      ? payload['args'].filter((entry): entry is string => typeof entry === 'string')
      : [],
    warning: firstString(payload['warning']),
  };
}

function parseOriginListInput(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)));
  }

  if (typeof value !== 'string') {
    return [];
  }

  return Array.from(new Set(value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)));
}

function stringifyOriginList(origins: string[]): string {
  return origins.join(', ');
}

function normalizeDiscordPrefixInput(value: string, fallbackToDefault = false): string {
  const parsed = parseDiscordPrefixList(value);
  if (parsed.length === 0) {
    return fallbackToDefault ? DEFAULT_DISCORD_PREFIX : '';
  }

  if (parsed.length === 1 && !value.includes(',')) {
    return parsed[0]!;
  }

  return parsed.join(', ');
}

function parseDiscordPrefixList(value: string): string[] {
  if (!value.includes(',')) {
    return value.trim().length > 0 ? [value] : [];
  }

  return value
    .split(',')
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix.length > 0);
}

function formatCommandPreview(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return normalizeWhitespace(value);
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const parts = value
    .filter((part): part is string => typeof part === 'string')
    .map((part) => normalizeWhitespace(part))
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    return undefined;
  }

  return parts.join(' ');
}

function humanizeMethod(method: string): string {
  return method
    .replace(/^codex\/event\//i, '')
    .replace(/[/_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function extractProviderMessageType(params?: Record<string, unknown>): string | undefined {
  const msg = asRecord(params?.['msg']);
  const value = msg?.['type'];
  return typeof value === 'string' ? value : undefined;
}

function extractProviderCommand(params?: Record<string, unknown>): string | undefined {
  const msg = asRecord(params?.['msg']);
  return formatCommandPreview(msg?.['command']) ?? formatCommandPreview(params?.['command']);
}

function extractProviderReasoningText(params?: Record<string, unknown>): string | undefined {
  const msg = asRecord(params?.['msg']);
  const delta = asRecord(params?.['delta']);
  const msgDelta = asRecord(msg?.['delta']);

  return firstString(
    params?.['text'],
    msg?.['text'],
    params?.['delta'],
    delta?.['text'],
    msg?.['delta'],
    msgDelta?.['text'],
  );
}

function extractProviderItemType(params?: Record<string, unknown>): string | undefined {
  const msg = asRecord(params?.['msg']);
  const item = asRecord(params?.['item']) ?? asRecord(msg?.['item']);
  const type = item?.['type'];
  return typeof type === 'string' ? type : undefined;
}

function extractProviderTurnStatus(params?: Record<string, unknown>): string | undefined {
  const msg = asRecord(params?.['msg']);
  const turn = asRecord(params?.['turn']) ?? asRecord(msg?.['turn']);
  const status = turn?.['status'];
  return typeof status === 'string' ? status : undefined;
}

function summarizeToolArgs(args?: Record<string, unknown>): string | undefined {
  if (!args) {
    return undefined;
  }

  const command = formatCommandPreview(args['command']);
  if (command) {
    return truncateText(command, 180);
  }

  const path = firstString(args['path'], args['file'], args['target'], args['cwd']);
  if (path) {
    return truncateText(path, 180);
  }

  const serialized = JSON.stringify(args);
  if (!serialized || serialized === '{}') {
    return undefined;
  }

  return truncateText(serialized, 180);
}

function summarizeToolResult(result?: ToolEvent['result']): string | undefined {
  if (!result) {
    return undefined;
  }

  if (result.success) {
    const output = normalizeWhitespace(result.output);
    return output.length > 0
      ? truncateText(output, 180)
      : 'Completed successfully';
  }

  const error = firstString(result.error, result.output) ?? 'Request failed';
  return truncateText(error, 180);
}

function getProviderStreamActivity(
  method: string,
  params?: Record<string, unknown>
): StreamActivityDraft | null {
  const normalizedMethod = method.toLowerCase();
  const messageType = extractProviderMessageType(params);
  const normalizedMessageType = messageType?.toLowerCase();
  const isIgnored = PROVIDER_ACTIVITY_IGNORED_PATTERNS.some((pattern) => (
    pattern.test(normalizedMethod) || Boolean(normalizedMessageType && pattern.test(normalizedMessageType))
  ));

  if (isIgnored) {
    return null;
  }

  if (normalizedMethod.includes('exec_approval_request') || normalizedMessageType?.includes('exec_approval_request')) {
    const command = extractProviderCommand(params);
    return {
      source: 'provider',
      status: 'Waiting for approval',
      detail: command ? `Command: ${truncateText(command, 180)}` : 'Tool execution requires confirmation.',
    };
  }

  if (normalizedMethod.includes('agent_reasoning') || normalizedMessageType?.includes('agent_reasoning')) {
    const text = extractProviderReasoningText(params);
    return {
      source: 'provider',
      status: 'Analyzing request',
      detail: text ? truncateText(text, 180) : 'Planning the next step.',
    };
  }

  if (normalizedMethod.includes('item/completed') || normalizedMessageType?.includes('item_completed')) {
    const itemType = extractProviderItemType(params);
    return {
      source: 'provider',
      status: 'Step completed',
      detail: itemType ? `Item: ${itemType}` : undefined,
    };
  }

  if (normalizedMethod.includes('turn/completed') || normalizedMessageType?.includes('turn_completed')) {
    const turnStatus = extractProviderTurnStatus(params);
    return {
      source: 'provider',
      status: turnStatus === 'failed' ? 'Turn failed' : 'Turn completed',
      detail: turnStatus ? `Status: ${turnStatus}` : undefined,
    };
  }

  return {
    source: 'provider',
    status: humanizeMethod(method),
  };
}

function isImportantProviderEvent(method: string, params?: Record<string, unknown>): boolean {
  const normalizedMethod = method.toLowerCase();
  const messageType = extractProviderMessageType(params)?.toLowerCase();
  const itemType = extractProviderItemType(params)?.toLowerCase();
  const turnStatus = extractProviderTurnStatus(params)?.toLowerCase();

  if (
    normalizedMethod.includes('approval') ||
    Boolean(messageType?.includes('approval'))
  ) {
    return true;
  }

  if (
    normalizedMethod.includes('exec') ||
    normalizedMethod.includes('apply_patch') ||
    normalizedMethod.includes('patch') ||
    Boolean(messageType?.includes('exec')) ||
    Boolean(messageType?.includes('apply_patch')) ||
    Boolean(messageType?.includes('patch'))
  ) {
    return true;
  }

  if (normalizedMethod.includes('item/completed') || Boolean(messageType?.includes('item_completed'))) {
    return Boolean(itemType && /(tool|exec|command|patch|shell|function)/.test(itemType));
  }

  if (normalizedMethod.includes('turn/completed') || Boolean(messageType?.includes('turn_completed'))) {
    return true;
  }

  if (
    normalizedMethod.includes('error') ||
    normalizedMethod.includes('failed') ||
    Boolean(messageType?.includes('error')) ||
    Boolean(messageType?.includes('failed'))
  ) {
    return true;
  }

  if (turnStatus === 'failed') {
    return true;
  }

  return false;
}

function getChannelTypeForSession(sessionId: string): SessionChannelType {
  if (sessionId.startsWith('discord:')) {
    return 'discord';
  }

  if (sessionId.startsWith('terminal:')) {
    return 'terminal';
  }

  return 'web';
}

function normalizeWebSessionId(value: string): string {
  return value.startsWith('web:') ? value : `web:${value}`;
}

function parseSessionSnapshotEntries(value: unknown): SessionSnapshotEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const record = asRecord(item);
    if (!record) {
      return [];
    }

    const sessionId = firstString(record['sessionId']);
    const channelTypeRaw = firstString(record['channelType']);
    const updatedAtRaw = firstString(record['updatedAt']);
    const messagesRaw = record['messages'];

    if (!sessionId || (channelTypeRaw !== 'web' && channelTypeRaw !== 'discord' && channelTypeRaw !== 'terminal')) {
      return [];
    }

    const updatedAt = updatedAtRaw ? new Date(updatedAtRaw) : new Date();

    const messages = Array.isArray(messagesRaw)
      ? messagesRaw.flatMap((message) => {
        const messageRecord = asRecord(message);
        if (!messageRecord) {
          return [];
        }

        const roleValue = firstString(messageRecord['role']);
        const content = firstRawString(messageRecord['content']) ?? '';

        if (roleValue !== 'user' && roleValue !== 'assistant') {
          return [];
        }

        const role: 'user' | 'assistant' = roleValue;
        return [{ role, content }];
      })
      : [];

    return [{
      sessionId,
      channelType: channelTypeRaw,
      updatedAt,
      messages,
    } satisfies SessionSnapshotEntry];
  });
}

function App() {
  const [sessionState, setSessionState] = useState(EMPTY_SESSION_CHAT_STATE);
  const [toolEventsBySession, setToolEventsBySession] = useState<Record<string, ToolEvent[]>>({});
  const [streamActivitiesBySession, setStreamActivitiesBySession] = useState<Record<string, StreamActivity[]>>({});
  const [mainSessionId, setMainSessionId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const [mode, setMode] = useState<SecurityMode>('safe');
  const [spicyEnabled, setSpicyEnabled] = useState(false);
  const [spicyObedienceEnabled, setSpicyObedienceEnabled] = useState(false);
  const [spicyEnableAck, setSpicyEnableAck] = useState('');
  const [isConfigMenuOpen, setIsConfigMenuOpen] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);

  const [llm, setLlm] = useState<LLMState>({ provider: 'openai', model: 'gpt-4o', reasoningEffort: 'medium' });
  const [discordConfig, setDiscordConfig] = useState<DiscordConfigState>({
    configured: false,
    prefix: DEFAULT_DISCORD_PREFIX,
  });
  const [discordPrefixDraft, setDiscordPrefixDraft] = useState(DEFAULT_DISCORD_PREFIX);
  const [discordTokenDraft, setDiscordTokenDraft] = useState('');
  const [discordClearToken, setDiscordClearToken] = useState(false);
  const [discordSaving, setDiscordSaving] = useState(false);

  const [browserConfig, setBrowserConfig] = useState<BrowserConfigState>(DEFAULT_BROWSER_CONFIG_STATE);
  const [browserPolicyDraft, setBrowserPolicyDraft] = useState<BrowserDomainPolicy>('none');
  const [browserAllowlistDraft, setBrowserAllowlistDraft] = useState('');
  const [browserBlocklistDraft, setBrowserBlocklistDraft] = useState('');
  const [browserRetentionDraft, setBrowserRetentionDraft] = useState('7');
  const [browserVersionDraft, setBrowserVersionDraft] = useState(DEFAULT_BROWSER_VERSION);
  const [browserSaving, setBrowserSaving] = useState(false);
  const [browserActionPending, setBrowserActionPending] = useState<'install' | 'update' | 'remove' | null>(null);

  const [latestScreenshot, setLatestScreenshot] = useState<LatestScreenshotPreview | null>(null);

  const [pendingProviderSwitch, setPendingProviderSwitch] = useState<LLMProviderId | null>(null);
  const [modelsByProvider, setModelsByProvider] = useState<Partial<Record<LLMProviderId, ProviderModelOption[]>>>({});
  const [modelsLoading, setModelsLoading] = useState(false);

  const activeSessionId = selectedSessionId ?? mainSessionId;
  const activeMessages = activeSessionId ? sessionState.messagesBySession[activeSessionId] ?? [] : [];
  const activeToolEvents = activeSessionId ? toolEventsBySession[activeSessionId] ?? [] : [];
  const activeStreamActivities = activeSessionId ? streamActivitiesBySession[activeSessionId] ?? [] : [];
  const activeIsStreaming = activeSessionId ? sessionState.streamingBySession[activeSessionId] === true : false;
  const activeIsReadOnly = isSessionReadOnly(activeSessionId, mainSessionId);
  const activeLatestScreenshot = latestScreenshot && activeSessionId === latestScreenshot.sessionId
    ? latestScreenshot
    : null;

  const sessionOptions = useMemo(
    () => buildSessionOptions(mainSessionId, sessionState.metaBySession),
    [mainSessionId, sessionState.metaBySession],
  );

  useEffect(() => {
    if (selectedSessionId && sessionOptions.some((option) => option.sessionId === selectedSessionId)) {
      return;
    }

    if (mainSessionId) {
      setSelectedSessionId(mainSessionId);
      return;
    }

    if (sessionOptions.length > 0) {
      setSelectedSessionId(sessionOptions[0]!.sessionId);
    }
  }, [mainSessionId, selectedSessionId, sessionOptions]);

  const appendToolEvent = useCallback((sessionId: string, event: Omit<ToolEvent, 'id' | 'timestamp'>) => {
    setToolEventsBySession((prev) => ({
      ...prev,
      [sessionId]: [
        ...(prev[sessionId] ?? []),
        {
          id: crypto.randomUUID(),
          timestamp: new Date(),
          ...event,
        },
      ],
    }));
  }, []);

  const appendStreamActivity = useCallback((sessionId: string, activity: StreamActivityDraft) => {
    setStreamActivitiesBySession((prev) => {
      const entries = prev[sessionId] ?? [];
      const entry: StreamActivity = {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        ...activity,
      };

      const last = entries[entries.length - 1];
      const nextEntries =
        last && last.source === entry.source && last.status === entry.status && last.detail === entry.detail
          ? [...entries.slice(0, -1), { ...last, timestamp: entry.timestamp }]
          : [...entries, entry];

      return {
        ...prev,
        [sessionId]: nextEntries.slice(-MAX_STREAM_ACTIVITIES),
      };
    });
  }, []);

  const clearStreamActivities = useCallback((sessionId: string) => {
    setStreamActivitiesBySession((prev) => ({
      ...prev,
      [sessionId]: [],
    }));
  }, []);

  const handleMessage = useCallback((data: Record<string, unknown>) => {
    const type = data['type'] as string;

    switch (type) {
      case 'connected': {
        setMode(data['mode'] as SecurityMode);
        setSpicyEnabled(data['spicyEnabled'] as boolean);
        setSpicyObedienceEnabled(data['spicyObedienceEnabled'] === true);

        const llmState = data['llm'] as LLMState | undefined;
        if (llmState?.provider && llmState?.model) {
          setLlm(llmState);
        }

        const discordState = parseDiscordConfig(data['discord']);
        if (discordState) {
          setDiscordConfig(discordState);
          setDiscordPrefixDraft(discordState.prefix);
          setDiscordTokenDraft('');
          setDiscordClearToken(false);
        }
        setDiscordSaving(false);
        setBrowserSaving(false);
        setBrowserActionPending(null);

        const browserState = parseBrowserConfig(data['browser']);
        if (browserState) {
          setBrowserConfig(browserState);
          setBrowserPolicyDraft(browserState.domainPolicy);
          setBrowserAllowlistDraft(stringifyOriginList(browserState.domainAllowlist));
          setBrowserBlocklistDraft(stringifyOriginList(browserState.domainBlocklist));
          setBrowserRetentionDraft(String(browserState.traceRetentionDays));
          setBrowserVersionDraft(browserState.desiredVersion);
        }

        const rawSessionId = firstString(data['sessionId']);
        if (rawSessionId) {
          const nextMainSessionId = normalizeWebSessionId(rawSessionId);
          setMainSessionId(nextMainSessionId);
          setSelectedSessionId((prev) => prev ?? nextMainSessionId);
          setSessionState((prev) => reduceSessionChatState(prev, {
            type: 'session_touch',
            sessionId: nextMainSessionId,
            channelType: 'web',
            updatedAt: new Date(),
          }));
        }
        break;
      }

      case 'session_snapshot': {
        const sessions = parseSessionSnapshotEntries(data['sessions']);
        setSessionState((prev) => reduceSessionChatState(prev, {
          type: 'session_snapshot',
          sessions,
        }));
        break;
      }

      case 'session_user_message': {
        const sessionId = firstString(data['sessionId']);
        const channelType = firstString(data['channelType']);
        const content = firstNonEmptyRawString(data['content']);
        if (!sessionId || !content || (channelType !== 'web' && channelType !== 'discord' && channelType !== 'terminal')) {
          break;
        }

        const timestamp = new Date();
        setSessionState((prev) => reduceSessionChatState(prev, {
          type: 'session_user_message',
          sessionId,
          channelType,
          content,
          timestamp,
        }));
        break;
      }

      case 'session_chunk': {
        const sessionId = firstString(data['sessionId']);
        const content = firstRawString(data['content']) ?? '';
        if (!sessionId) {
          break;
        }

        setSessionState((prev) => reduceSessionChatState(prev, {
          type: 'session_chunk',
          sessionId,
          content,
          timestamp: new Date(),
        }));
        appendStreamActivity(sessionId, {
          source: 'system',
          status: 'Writing response',
        });
        break;
      }

      case 'session_message_end': {
        const sessionId = firstString(data['sessionId']);
        const content = firstRawString(data['content']) ?? '';
        if (!sessionId) {
          break;
        }

        setSessionState((prev) => reduceSessionChatState(prev, {
          type: 'session_message_end',
          sessionId,
          content,
          timestamp: new Date(),
        }));
        clearStreamActivities(sessionId);
        break;
      }

      case 'message_received': {
        const rawSessionId = firstString(data['sessionId']);
        const sessionId = rawSessionId
          ? normalizeWebSessionId(rawSessionId)
          : (mainSessionId ?? selectedSessionId);

        if (!sessionId) {
          break;
        }

        const timestamp = new Date();
        setSessionState((prev) => reduceSessionChatState(prev, {
          type: 'session_stream_start',
          sessionId,
          channelType: 'web',
          timestamp,
        }));

        clearStreamActivities(sessionId);
        appendStreamActivity(sessionId, {
          source: 'system',
          status: 'Starting model turn',
          detail: 'Waiting for live updates from the provider.',
        });
        break;
      }

      case 'models': {
        setModelsLoading(false);

        const provider = data['provider'] as LLMProviderId;
        const models = Array.isArray(data['models'])
          ? (data['models'] as ProviderModelOption[])
          : [];
        const error = typeof data['error'] === 'string' ? data['error'] : '';

        setModelsByProvider((prev) => ({
          ...prev,
          [provider]: models,
        }));

        if (error) {
          setPendingProviderSwitch(null);
          const targetSession = mainSessionId ?? selectedSessionId;
          if (targetSession) {
            setSessionState((prev) => reduceSessionChatState(prev, {
              type: 'session_message_end',
              sessionId: targetSession,
              content: `Error: ${error}`,
              timestamp: new Date(),
            }));
          }
        } else if (models.length === 0 && pendingProviderSwitch === provider) {
          setPendingProviderSwitch(null);
        }
        break;
      }

      case 'model_changed': {
        const llmState = data['llm'] as LLMState | undefined;
        if (llmState?.provider && llmState?.model) {
          setLlm(llmState);
          setPendingProviderSwitch(null);
        }
        break;
      }

      case 'codex_install_required': {
        const message = String(data['message'] ?? 'Codex CLI is required for openai-codex.');
        const targetSession = mainSessionId ?? selectedSessionId;
        if (targetSession) {
          setSessionState((prev) => reduceSessionChatState(prev, {
            type: 'session_message_end',
            sessionId: targetSession,
            content: `Error: ${message}`,
            timestamp: new Date(),
          }));
        }
        setPendingProviderSwitch(null);
        setModelsLoading(false);
        break;
      }

      case 'tool_start': {
        const tool = data['tool'] as string;
        const args = asRecord(data['args']);
        const sessionId = firstString(data['sessionId']) ?? mainSessionId;
        if (!sessionId) {
          break;
        }

        appendToolEvent(sessionId, {
          type: 'start',
          tool,
          args,
        });

        appendStreamActivity(sessionId, {
          source: 'tool',
          status: `Running ${tool}`,
          detail: summarizeToolArgs(args),
        });

        setSessionState((prev) => reduceSessionChatState(prev, {
          type: 'session_touch',
          sessionId,
          channelType: getChannelTypeForSession(sessionId),
          updatedAt: new Date(),
        }));
        break;
      }

      case 'tool_end': {
        const tool = data['tool'] as string;
        const result = data['result'] as ToolEvent['result'] | undefined;
        const sessionId = firstString(data['sessionId']) ?? mainSessionId;
        if (!sessionId) {
          break;
        }

        appendToolEvent(sessionId, {
          type: 'end',
          tool,
          result,
        });

        appendStreamActivity(sessionId, {
          source: 'tool',
          status: result?.success === false ? `Failed ${tool}` : `Finished ${tool}`,
          detail: summarizeToolResult(result),
        });

        setSessionState((prev) => reduceSessionChatState(prev, {
          type: 'session_touch',
          sessionId,
          channelType: getChannelTypeForSession(sessionId),
          updatedAt: new Date(),
        }));
        break;
      }

      case 'provider_event': {
        const payload = asRecord(data['event']);
        const method = payload?.['method'];
        const params = asRecord(payload?.['params']);
        const activity = typeof method === 'string' ? getProviderStreamActivity(method, params) : null;
        const important = typeof method === 'string' ? isImportantProviderEvent(method, params) : false;
        const sessionId = firstString(data['sessionId']) ?? mainSessionId;
        if (!sessionId) {
          break;
        }

        appendToolEvent(sessionId, {
          type: 'provider',
          tool: typeof method === 'string' ? method : 'provider/notification',
          args: params,
          detail: activity?.detail ?? (important ? 'Important provider event' : 'Codex app-server notification'),
          important,
        });

        if (activity) {
          appendStreamActivity(sessionId, activity);
        }

        setSessionState((prev) => reduceSessionChatState(prev, {
          type: 'session_touch',
          sessionId,
          channelType: getChannelTypeForSession(sessionId),
          updatedAt: new Date(),
        }));
        break;
      }

      case 'confirm_request': {
        const details = asRecord(data['details']);
        const parsedDetails: ConfirmationDetails | undefined = details && typeof details['tool'] === 'string'
          ? {
            tool: details['tool'] as string,
            action: typeof details['action'] === 'string' ? details['action'] : 'tool execution',
            summary: typeof details['summary'] === 'string' ? details['summary'] : '',
            command: firstString(details['command']),
            cwd: firstString(details['cwd']),
            path: firstString(details['path']),
            args: asRecord(details['args']),
          }
          : undefined;

        const rawSession = firstString(data['sessionId']);
        const sessionId = rawSession
          ? normalizeWebSessionId(rawSession)
          : (mainSessionId ?? selectedSessionId);
        if (!sessionId) {
          break;
        }

        appendToolEvent(sessionId, {
          type: 'start',
          tool: parsedDetails?.tool ?? 'confirmation',
          args: parsedDetails?.args,
          detail: firstString(parsedDetails?.summary, data['prompt']) ?? 'Waiting for confirmation',
        });

        setPendingConfirmation({
          id: crypto.randomUUID(),
          prompt: data['prompt'] as string,
          details: parsedDetails,
          sessionId,
        });

        appendStreamActivity(sessionId, {
          source: 'system',
          status: 'Waiting for your confirmation',
          detail: firstString(parsedDetails?.summary, data['prompt']),
        });
        break;
      }

      case 'mode_changed':
        setMode(data['mode'] as SecurityMode);
        break;

      case 'spicy_obedience_changed':
        setSpicyObedienceEnabled(data['enabled'] === true);
        break;

      case 'spicy_enabled_changed':
        setSpicyEnabled(data['enabled'] === true);
        if (data['enabled'] === true) {
          setSpicyEnableAck('');
        }
        break;

      case 'discord_config_updated': {
        const discordState = parseDiscordConfig(data['discord']);
        if (discordState) {
          setDiscordConfig(discordState);
          setDiscordPrefixDraft(discordState.prefix);
        }
        setDiscordTokenDraft('');
        setDiscordClearToken(false);
        setDiscordSaving(false);
        break;
      }

      case 'mcp_browser_status': {
        const browserState = parseBrowserConfig(data['browser']);
        if (browserState) {
          setBrowserConfig(browserState);
          setBrowserPolicyDraft(browserState.domainPolicy);
          setBrowserAllowlistDraft(stringifyOriginList(browserState.domainAllowlist));
          setBrowserBlocklistDraft(stringifyOriginList(browserState.domainBlocklist));
          setBrowserRetentionDraft(String(browserState.traceRetentionDays));
          setBrowserVersionDraft(browserState.desiredVersion);
        }
        setBrowserSaving(false);
        setBrowserActionPending(null);
        break;
      }

      case 'session_cleared': {
        const rawSession = firstString(data['sessionId']);
        const clearedSessionId = rawSession
          ? normalizeWebSessionId(rawSession)
          : (mainSessionId ?? selectedSessionId);

        if (!clearedSessionId) {
          break;
        }

        setSessionState((prev) => reduceSessionChatState(prev, {
          type: 'session_clear',
          sessionId: clearedSessionId,
          updatedAt: new Date(),
        }));

        setToolEventsBySession((prev) => ({
          ...prev,
          [clearedSessionId]: [],
        }));

        clearStreamActivities(clearedSessionId);
        break;
      }

      case 'error': {
        setDiscordSaving(false);
        setBrowserSaving(false);
        setBrowserActionPending(null);

        const targetSession = mainSessionId ?? selectedSessionId;
        if (!targetSession) {
          break;
        }

        const error = data['error'];
        const content = typeof error === 'string' && error.trim()
          ? `Error: ${error}`
          : 'Error: Request failed';

        setSessionState((prev) => reduceSessionChatState(prev, {
          type: 'session_message_end',
          sessionId: targetSession,
          content,
          timestamp: new Date(),
        }));
        clearStreamActivities(targetSession);
        break;
      }

      // Legacy web-only events are intentionally ignored because session-scoped events are authoritative.
      case 'chunk':
      case 'stream_end':
      case 'message':
      default:
        break;
    }
  }, [
    appendStreamActivity,
    appendToolEvent,
    clearStreamActivities,
    mainSessionId,
    pendingProviderSwitch,
    selectedSessionId,
  ]);

  const { send, connected, connecting } = useWebSocket(getWebSocketUrl(), handleMessage);


  useEffect(() => {
    if (!connected) {
      return undefined;
    }

    const requestSnapshot = () => {
      send({ type: 'get_session_snapshot' });
    };

    const requestBrowserStatus = () => {
      send({ type: 'get_mcp_browser_status' });
    };

    requestSnapshot();
    requestBrowserStatus();

    const snapshotIntervalId = window.setInterval(requestSnapshot, 2500);
    const browserIntervalId = window.setInterval(requestBrowserStatus, 8000);

    return () => {
      window.clearInterval(snapshotIntervalId);
      window.clearInterval(browserIntervalId);
    };
  }, [connected, send]);

  useEffect(() => {
    const clearPreview = () => {
      setLatestScreenshot((previous) => (previous ? null : previous));
    };

    if (!connected || !activeSessionId) {
      clearPreview();
      return undefined;
    }

    if (shouldResetLatestScreenshotPreview(latestScreenshot?.sessionId ?? null, activeSessionId)) {
      clearPreview();
    }

    let cancelled = false;

    const pollLatestScreenshot = async () => {
      try {
        const baseScreenshotUrl = buildLatestScreenshotUrl(activeSessionId);
        const response = await fetch(baseScreenshotUrl, {
          method: 'HEAD',
          cache: 'no-store',
        });

        if (response.status === 404) {
          if (!cancelled) {
            clearPreview();
          }
          return;
        }

        if (!response.ok) {
          return;
        }

        const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
        if (!contentType.startsWith('image/')) {
          if (!cancelled) {
            clearPreview();
          }
          return;
        }

        const imageUrl = `${baseScreenshotUrl}&ts=${Date.now()}`;

        if (cancelled) {
          return;
        }

        setLatestScreenshot(() => {
          return {
            sessionId: activeSessionId,
            imageUrl,
            capturedAt: new Date(),
          };
        });
      } catch {
        // Ignore poll errors and retry on next interval.
      }
    };

    void pollLatestScreenshot();
    const intervalId = window.setInterval(() => {
      void pollLatestScreenshot();
    }, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeSessionId, connected, latestScreenshot?.sessionId]);
  useEffect(() => {
    if (!isConfigMenuOpen) {
      return undefined;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsConfigMenuOpen(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isConfigMenuOpen]);

  useEffect(() => {
    if (!connected) {
      return;
    }

    const provider = pendingProviderSwitch ?? llm.provider;
    const models = modelsByProvider[provider];

    if (!pendingProviderSwitch || !models || models.length === 0) {
      return;
    }

    const defaultModel = models.find((model) => model.isDefault)?.id ?? models[0]!.id;
    const defaultModelOption = models.find((model) => model.id === defaultModel);
    const reasoningEffort = provider === 'openai-codex'
      ? pickReasoningEffort(defaultModelOption, llm.reasoningEffort)
      : undefined;

    send({
      type: 'set_model',
      provider,
      model: defaultModel,
      reasoningEffort,
    });
  }, [connected, llm.reasoningEffort, llm.provider, modelsByProvider, pendingProviderSwitch, send]);

  const handleSendMessage = useCallback((content: string) => {
    if (!content.trim() || !connected || !mainSessionId || selectedSessionId !== mainSessionId) {
      return;
    }

    send({ type: 'message', content });
  }, [connected, mainSessionId, selectedSessionId, send]);

  const handleConfirm = useCallback((decision: ConfirmationDecision) => {
    const confirmation = pendingConfirmation;
    send({ type: 'confirm_response', decision });
    setPendingConfirmation(null);

    if (!confirmation) {
      return;
    }

    const allowed = decision !== 'cancel';
    appendToolEvent(confirmation.sessionId, {
      type: 'end',
      tool: confirmation.details?.tool ?? 'confirmation',
      detail: firstString(confirmation.details?.summary, confirmation.prompt),
      result: {
        success: allowed,
        output: allowed
          ? (decision === 'allow_always' ? 'Approved for this session' : 'Approved once')
          : 'Cancelled by user',
        error: allowed ? undefined : 'Cancelled by user',
      },
    });
  }, [appendToolEvent, pendingConfirmation, send]);

  const handleModeChange = useCallback((newMode: SecurityMode) => {
    if (newMode === 'spicy' && !spicyEnabled) {
      alert('Spicy mode is not enabled. Re-run the installer and accept the risk.');
      return;
    }
    send({ type: 'set_mode', mode: newMode });
  }, [send, spicyEnabled]);

  const handleSpicyObedienceChange = useCallback((enabled: boolean) => {
    send(buildSetSpicyObedienceMessage(enabled));
  }, [send]);

  const handleEnableSpicyMode = useCallback(() => {
    send(buildEnableSpicyModeMessage(spicyEnableAck));
  }, [send, spicyEnableAck]);

  const handleClearSession = useCallback(() => {
    if (!connected || !mainSessionId || selectedSessionId !== mainSessionId) {
      return;
    }

    send({ type: 'clear_session' });
    setIsConfigMenuOpen(false);
  }, [connected, mainSessionId, selectedSessionId, send]);

  const handleProviderChange = useCallback((provider: LLMProviderId) => {
    setPendingProviderSwitch(provider);
    setModelsLoading(true);
    send({ type: 'get_models', provider });
  }, [send]);

  const handleModelChange = useCallback((model: string) => {
    const provider = pendingProviderSwitch ?? llm.provider;
    const models = modelsByProvider[provider] ?? [];
    const selectedModel = models.find((candidate) => candidate.id === model);
    const reasoningEffort = provider === 'openai-codex'
      ? pickReasoningEffort(selectedModel, llm.reasoningEffort)
      : undefined;

    send({ type: 'set_model', provider, model, reasoningEffort });
  }, [llm.provider, llm.reasoningEffort, modelsByProvider, pendingProviderSwitch, send]);

  const selectedProvider = pendingProviderSwitch ?? llm.provider;
  const selectedModels = modelsByProvider[selectedProvider] ?? [];
  const selectedModelValue = selectedModels.some((model) => model.id === llm.model)
    ? llm.model
    : (selectedModels[0]?.id ?? llm.model);
  const selectedModel = selectedModels.find((model) => model.id === selectedModelValue);
  const isSpicyModeActive = mode === 'spicy';
  const canToggleSpicyMode = spicyEnabled || isSpicyModeActive;
  const canEnableSpicyMode = spicyEnableAck.trim() === 'I ACCEPT THE RISK';
  const selectedReasoningOptions = selectedProvider === 'openai-codex'
    ? getReasoningOptionsForModel(selectedModel)
    : [];
  const selectedReasoningEffort = selectedProvider === 'openai-codex'
    ? pickReasoningEffort(selectedModel, llm.reasoningEffort)
    : undefined;
  const visibleReasoningOptions = CODEX_REASONING_EFFORT_OPTIONS
    .filter((option) => selectedReasoningOptions.includes(option.value));

  const handleReasoningEffortChange = useCallback((reasoningEffort: CodexReasoningEffort) => {
    const provider = pendingProviderSwitch ?? llm.provider;

    if (provider !== 'openai-codex') {
      return;
    }

    send({
      type: 'set_model',
      provider,
      model: selectedModelValue,
      reasoningEffort,
    });
  }, [llm.provider, pendingProviderSwitch, selectedModelValue, send]);

  const handleDiscordSave = useCallback(() => {
    const normalizedPrefix = normalizeDiscordPrefixInput(discordPrefixDraft);
    if (normalizedPrefix.length === 0) {
      alert('Discord prefix list cannot be empty.');
      return;
    }

    setDiscordSaving(true);
    send({
      type: 'set_discord_config',
      prefix: normalizedPrefix,
      token: discordTokenDraft.trim().length > 0 ? discordTokenDraft.trim() : undefined,
      clearToken: discordClearToken,
    });
  }, [discordClearToken, discordPrefixDraft, discordTokenDraft, send]);


  const handleInstallMcpBrowser = useCallback(() => {
    setBrowserActionPending('install');
    send({ type: 'setup_mcp_browser' });
  }, [send]);

  const handleUpdateMcpBrowser = useCallback(() => {
    setBrowserActionPending('update');
    send({ type: 'setup_mcp_browser' });
  }, [send]);

  const handleRemoveMcpBrowser = useCallback(() => {
    setBrowserActionPending('remove');
    send({ type: 'remove_mcp_browser' });
  }, [send]);

  const handleSaveBrowserPolicy = useCallback(() => {
    const traceRetentionDays = Number.parseInt(browserRetentionDraft.trim(), 10);
    if (!Number.isFinite(traceRetentionDays) || traceRetentionDays < 1) {
      alert('Trace retention must be a whole number >= 1 day.');
      return;
    }

    const allowlist = parseOriginListInput(browserAllowlistDraft);
    const blocklist = parseOriginListInput(browserBlocklistDraft);

    if (browserPolicyDraft === 'allowlist' && allowlist.length === 0) {
      alert('Allowlist policy requires at least one origin.');
      return;
    }

    if (browserPolicyDraft === 'blocklist' && blocklist.length === 0) {
      alert('Blocklist policy requires at least one origin.');
      return;
    }

    setBrowserSaving(true);
    send({
      type: 'set_browser_policy',
      domainPolicy: browserPolicyDraft,
      domainAllowlist: allowlist,
      domainBlocklist: blocklist,
      traceRetentionDays,
      mcpPlaywrightVersion: browserVersionDraft.trim().length > 0
        ? browserVersionDraft.trim()
        : browserConfig.desiredVersion,
    });
  }, [
    browserAllowlistDraft,
    browserBlocklistDraft,
    browserConfig.desiredVersion,
    browserPolicyDraft,
    browserRetentionDraft,
    browserVersionDraft,
    send,
  ]);

  const discordHasChanges =
    discordPrefixDraft !== discordConfig.prefix ||
    discordTokenDraft.trim().length > 0 ||
    discordClearToken;

  const browserPolicyHasChanges =
    browserPolicyDraft !== browserConfig.domainPolicy ||
    browserAllowlistDraft !== stringifyOriginList(browserConfig.domainAllowlist) ||
    browserBlocklistDraft !== stringifyOriginList(browserConfig.domainBlocklist) ||
    browserRetentionDraft !== String(browserConfig.traceRetentionDays) ||
    browserVersionDraft.trim() !== browserConfig.desiredVersion;

  const browserBusy = browserSaving || browserActionPending !== null;

  const canClearMainSession = connected && !!mainSessionId && selectedSessionId === mainSessionId && !activeIsStreaming;

  const activeReadOnlyChannel = activeIsReadOnly && activeSessionId
    ? getChannelTypeForSession(activeSessionId)
    : null;
  const readOnlyTarget = activeReadOnlyChannel === 'discord'
    ? 'Discord'
    : activeReadOnlyChannel === 'terminal'
      ? 'Terminal TUI'
      : 'the original channel';
  const readOnlyHintText = `Read-only here. Reply in ${readOnlyTarget}.`;
  const readOnlyChipText = activeReadOnlyChannel === 'discord'
    ? 'Read-only (Discord)'
    : activeReadOnlyChannel === 'terminal'
      ? 'Read-only (Terminal)'
      : 'Read-only';

  const composerDisabled = isComposerDisabled(connected, activeIsStreaming, activeSessionId, mainSessionId);
  const composerPlaceholder = !connected
    ? 'Connecting...'
    : activeIsReadOnly
      ? readOnlyHintText
      : 'Ask Keygate anything...';

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <div className="brand-block">
            <span className="brand-mark" aria-hidden="true" />
            <div className="brand-copy">
              <h1 className="logo">Keygate</h1>
              <p className="brand-subtitle">AI Gateway Workspace</p>
            </div>
          </div>
          <SecurityBadge
            mode={mode}
            spicyEnabled={spicyEnabled}
            onModeChange={handleModeChange}
          />
        </div>
        <div className="header-right">
          <div className={`connection-status ${connected ? 'connected' : connecting ? 'connecting' : 'disconnected'}`}>
            <span className="status-dot" />
            {connected ? 'Connected' : connecting ? 'Connecting...' : 'Disconnected'}
          </div>
          <button
            className="btn-secondary"
            onClick={() => setIsConfigMenuOpen((open) => !open)}
            aria-expanded={isConfigMenuOpen}
            aria-controls="config-drawer"
          >
            Config
          </button>
          <button className="btn-secondary" onClick={handleClearSession} disabled={!canClearMainSession}>
            Clear main session
          </button>
        </div>
      </header>

      <main className="app-main">
        <section className="chat-shell">
          <div className="chat-toolbar">
            <label className="llm-control chat-session-control">
              <span>Chat View</span>
              <select
                value={activeSessionId ?? ''}
                onChange={(event) => setSelectedSessionId(event.target.value)}
                disabled={!connected || sessionOptions.length === 0}
              >
                {sessionOptions.length === 0 ? (
                  <option value="">No sessions yet</option>
                ) : (
                  sessionOptions.map((option) => (
                    <option key={option.sessionId} value={option.sessionId}>{option.label}</option>
                  ))
                )}
              </select>
            </label>
            {activeIsReadOnly && (
              <span className="session-readonly-chip">{readOnlyChipText}</span>
            )}
          </div>

          <ChatView
            messages={activeMessages}
            onSendMessage={handleSendMessage}
            isStreaming={activeIsStreaming}
            streamActivities={activeStreamActivities}
            disabled={composerDisabled}
            inputPlaceholder={composerPlaceholder}
            readOnlyHint={activeIsReadOnly ? readOnlyHintText : undefined}
          />
        </section>

        <LiveActivityLog events={activeToolEvents} latestScreenshot={activeLatestScreenshot} />
      </main>

      {isConfigMenuOpen && (
        <div
          className="config-drawer-backdrop"
          onClick={() => setIsConfigMenuOpen(false)}
          role="presentation"
        >
          <aside
            id="config-drawer"
            className="config-drawer"
            onClick={(event) => event.stopPropagation()}
            aria-label="Configuration"
          >
            <div className="config-drawer-header">
              <h2>Configuration</h2>
              <button
                className="config-close-btn"
                onClick={() => setIsConfigMenuOpen(false)}
                aria-label="Close configuration"
              >
                Close
              </button>
            </div>

            <section className="config-section">
              <h3>Security</h3>
              <label className="config-switch-row">
                <span className="config-switch-copy">
                  <strong>Spicy Mode</strong>
                  <small>Enable autonomous full-host execution.</small>
                </span>
                <input
                  type="checkbox"
                  checked={isSpicyModeActive}
                  onChange={(event) => handleModeChange(event.target.checked ? 'spicy' : 'safe')}
                  disabled={!connected || activeIsStreaming || !canToggleSpicyMode}
                />
              </label>
              {!spicyEnabled && (
                <div className="config-risk-block">
                  <p className="config-hint">
                    Spicy mode is currently locked. To unlock it, type <code>I ACCEPT THE RISK</code>.
                  </p>
                  <input
                    className="config-risk-input"
                    type="text"
                    value={spicyEnableAck}
                    onChange={(event) => setSpicyEnableAck(event.target.value)}
                    placeholder="I ACCEPT THE RISK"
                    spellCheck={false}
                    autoComplete="off"
                    disabled={!connected || activeIsStreaming}
                  />
                  <button
                    className="btn-secondary"
                    onClick={handleEnableSpicyMode}
                    disabled={!connected || activeIsStreaming || !canEnableSpicyMode}
                  >
                    Enable Spicy Mode
                  </button>
                </div>
              )}

              <label className="config-switch-row">
                <span className="config-switch-copy">
                  <strong>Spicy Max Obedience</strong>
                  <small>Best-effort reduction of avoidable refusals in spicy mode.</small>
                </span>
                <input
                  type="checkbox"
                  checked={spicyObedienceEnabled}
                  onChange={(event) => handleSpicyObedienceChange(event.target.checked)}
                  disabled={!connected || activeIsStreaming || !spicyEnabled || !isSpicyModeActive}
                />
              </label>
            </section>

            <section className="config-section">
              <h3>Model</h3>
              <label className="llm-control config-control">
                <span>Provider</span>
                <select
                  value={selectedProvider}
                  onChange={(event) => handleProviderChange(event.target.value as LLMProviderId)}
                  disabled={!connected || activeIsStreaming}
                >
                  {PROVIDER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>

              <label className="llm-control config-control">
                <span>Model</span>
                <select
                  value={selectedModelValue}
                  onChange={(event) => handleModelChange(event.target.value)}
                  disabled={!connected || activeIsStreaming || selectedModels.length === 0 || modelsLoading}
                >
                  {selectedModels.length === 0 ? (
                    <option value={llm.model}>{modelsLoading ? 'Loading models...' : llm.model}</option>
                  ) : (
                    selectedModels.map((model) => (
                      <option key={model.id} value={model.id}>{model.displayName}</option>
                    ))
                  )}
                </select>
              </label>

              {selectedProvider === 'openai-codex' && (
                <label className="llm-control config-control">
                  <span>Reasoning</span>
                  <select
                    value={selectedReasoningEffort ?? 'medium'}
                    onChange={(event) => handleReasoningEffortChange(event.target.value as CodexReasoningEffort)}
                    disabled={
                      !connected ||
                      activeIsStreaming ||
                      selectedModels.length === 0 ||
                      modelsLoading ||
                      visibleReasoningOptions.length === 0
                    }
                  >
                    {visibleReasoningOptions.length === 0 ? (
                      <option value={selectedReasoningEffort ?? 'medium'}>Medium</option>
                    ) : (
                      visibleReasoningOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))
                    )}
                  </select>
                </label>
              )}

              {modelsLoading && (
                <span className="models-loading">Refreshing model catalog...</span>
              )}
            </section>


            <section className="config-section">
              <h3>MCP Browser</h3>
              <p className="config-note">Installed: {browserConfig.installed ? 'Yes' : 'No'}</p>
              <p className="config-note">Health: {browserConfig.healthy ? 'Ready' : 'Needs setup'}</p>
              <p className="config-note">
                Version: {browserConfig.configuredVersion ?? '(not configured)'} / pinned {browserConfig.desiredVersion}
              </p>
              <p className="config-note">Policy: {browserConfig.domainPolicy}</p>
              <p className="config-note">Output path: {browserConfig.artifactsPath || '(not set)'}</p>

              {browserConfig.warning && (
                <p className="config-note config-warning">{browserConfig.warning}</p>
              )}

              <div className="config-button-row">
                <button
                  className="btn-secondary"
                  onClick={handleInstallMcpBrowser}
                  disabled={!connected || activeIsStreaming || browserBusy || browserConfig.installed}
                >
                  {browserActionPending === 'install' ? 'Installing...' : 'Install'}
                </button>
                <button
                  className="btn-secondary"
                  onClick={handleUpdateMcpBrowser}
                  disabled={!connected || activeIsStreaming || browserBusy || !browserConfig.installed}
                >
                  {browserActionPending === 'update' ? 'Updating...' : 'Update'}
                </button>
                <button
                  className="btn-secondary"
                  onClick={handleRemoveMcpBrowser}
                  disabled={!connected || activeIsStreaming || browserBusy || !browserConfig.installed}
                >
                  {browserActionPending === 'remove' ? 'Removing...' : 'Remove'}
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => send({ type: 'get_mcp_browser_status' })}
                  disabled={!connected || activeIsStreaming || browserBusy}
                >
                  Refresh Status
                </button>
              </div>

              <label className="llm-control config-control">
                <span>Domain Policy</span>
                <select
                  value={browserPolicyDraft}
                  onChange={(event) => setBrowserPolicyDraft(event.target.value as BrowserDomainPolicy)}
                  disabled={!connected || activeIsStreaming || browserBusy}
                >
                  {BROWSER_DOMAIN_POLICY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>

              <label className="llm-control config-control">
                <span>Allowlist Origins (comma separated)</span>
                <input
                  className="config-text-input"
                  type="text"
                  value={browserAllowlistDraft}
                  onChange={(event) => setBrowserAllowlistDraft(event.target.value)}
                  placeholder="https://example.com, https://docs.example.com"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={!connected || activeIsStreaming || browserBusy || browserPolicyDraft !== 'allowlist'}
                />
              </label>

              <label className="llm-control config-control">
                <span>Blocklist Origins (comma separated)</span>
                <input
                  className="config-text-input"
                  type="text"
                  value={browserBlocklistDraft}
                  onChange={(event) => setBrowserBlocklistDraft(event.target.value)}
                  placeholder="https://ads.example, https://trackers.example"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={!connected || activeIsStreaming || browserBusy || browserPolicyDraft !== 'blocklist'}
                />
              </label>

              <label className="llm-control config-control">
                <span>Retention (days)</span>
                <input
                  className="config-text-input"
                  type="number"
                  min={1}
                  value={browserRetentionDraft}
                  onChange={(event) => setBrowserRetentionDraft(event.target.value)}
                  disabled={!connected || activeIsStreaming || browserBusy}
                />
              </label>

              <label className="llm-control config-control">
                <span>Playwright MCP Version</span>
                <input
                  className="config-text-input"
                  type="text"
                  value={browserVersionDraft}
                  onChange={(event) => setBrowserVersionDraft(event.target.value)}
                  placeholder={DEFAULT_BROWSER_VERSION}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={!connected || activeIsStreaming || browserBusy}
                />
              </label>

              <button
                className="btn-secondary"
                onClick={handleSaveBrowserPolicy}
                disabled={!connected || activeIsStreaming || browserBusy || !browserPolicyHasChanges}
              >
                {browserSaving ? 'Saving...' : 'Save Browser Policy'}
              </button>
              <small className="config-note">
                Policy changes reconfigure Playwright MCP when the browser server is already installed.
              </small>
            </section>
            <section className="config-section">
              <h3>Discord Bot</h3>
              <p className="config-note">
                Status: {discordConfig.configured ? 'Token configured' : 'Token not configured'}
              </p>

              <label className="llm-control config-control">
                <span>Command Prefixes</span>
                <input
                  className="config-text-input"
                  type="text"
                  value={discordPrefixDraft}
                  onChange={(event) => setDiscordPrefixDraft(event.target.value)}
                  placeholder={`${DEFAULT_DISCORD_PREFIX}, ?keygate , 1`}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={!connected || activeIsStreaming || discordSaving}
                />
              </label>
              <small className="config-note">Use commas to separate multiple prefixes.</small>

              <label className="llm-control config-control">
                <span>Bot Token</span>
                <input
                  className="config-text-input"
                  type="password"
                  value={discordTokenDraft}
                  onChange={(event) => {
                    setDiscordTokenDraft(event.target.value);
                    if (event.target.value.trim().length > 0) {
                      setDiscordClearToken(false);
                    }
                  }}
                  placeholder={
                    discordConfig.configured
                      ? 'Leave blank to keep current token'
                      : 'Paste Discord bot token'
                  }
                  autoComplete="off"
                  disabled={!connected || activeIsStreaming || discordSaving}
                />
              </label>

              <label className="config-switch-row">
                <span className="config-switch-copy">
                  <strong>Clear saved token</strong>
                  <small>Remove token from local config on save.</small>
                </span>
                <input
                  type="checkbox"
                  checked={discordClearToken}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setDiscordClearToken(checked);
                    if (checked) {
                      setDiscordTokenDraft('');
                    }
                  }}
                  disabled={!connected || activeIsStreaming || discordSaving || !discordConfig.configured}
                />
              </label>

              <button
                className="btn-secondary"
                onClick={handleDiscordSave}
                disabled={!connected || activeIsStreaming || discordSaving || !discordHasChanges}
              >
                {discordSaving ? 'Saving...' : 'Save Discord Config'}
              </button>
              <small className="config-note">Restart the Discord bot process to apply updated settings.</small>
            </section>

            <section className="config-section">
              <h3>Session</h3>
              <button
                className="btn-secondary"
                onClick={handleClearSession}
                disabled={!canClearMainSession}
              >
                Clear main session
              </button>
            </section>
          </aside>
        </div>
      )}

      {pendingConfirmation && (
        <ConfirmationModal
          prompt={pendingConfirmation.prompt}
          details={pendingConfirmation.details}
          onAllowOnce={() => handleConfirm('allow_once')}
          onAllowAlways={() => handleConfirm('allow_always')}
          onCancel={() => handleConfirm('cancel')}
        />
      )}
    </div>
  );
}

export default App;
