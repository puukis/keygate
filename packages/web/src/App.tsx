import { useState, useRef, useCallback, useEffect } from 'react';
import { ChatView } from './components/ChatView';
import { LiveActivityLog } from './components/LiveActivityLog';
import { SecurityBadge } from './components/SecurityBadge';
import { ConfirmationModal } from './components/ConfirmationModal';
import { useWebSocket } from './hooks/useWebSocket';
import './App.css';

export type SecurityMode = 'safe' | 'spicy';
export type LLMProviderId = 'openai' | 'gemini' | 'ollama' | 'openai-codex';
type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
type ConfirmationDecision = 'allow_once' | 'allow_always' | 'cancel';

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

const MAX_STREAM_ACTIVITIES = 8;
const PROVIDER_ACTIVITY_IGNORED_PATTERNS: RegExp[] = [
  /ratelimits/i,
  /tokenusage/i,
  /token_count/i,
  /reasoning_content_delta/i,
  /summarytextdelta/i,
  /agent_reasoning_delta/i,
];

type StreamActivityDraft = Omit<StreamActivity, 'id' | 'timestamp'>;

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

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [streamActivities, setStreamActivities] = useState<StreamActivity[]>([]);
  const [mode, setMode] = useState<SecurityMode>('safe');
  const [spicyEnabled, setSpicyEnabled] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [llm, setLlm] = useState<LLMState>({ provider: 'openai', model: 'gpt-4o', reasoningEffort: 'medium' });
  const [pendingProviderSwitch, setPendingProviderSwitch] = useState<LLMProviderId | null>(null);
  const [modelsByProvider, setModelsByProvider] = useState<Partial<Record<LLMProviderId, ProviderModelOption[]>>>({});
  const [modelsLoading, setModelsLoading] = useState(false);
  const streamBufferRef = useRef('');

  const appendStreamActivity = useCallback((activity: StreamActivityDraft) => {
    setStreamActivities((prev) => {
      const entry: StreamActivity = {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        ...activity,
      };

      const last = prev[prev.length - 1];
      if (last && last.source === entry.source && last.status === entry.status && last.detail === entry.detail) {
        return [...prev.slice(0, -1), { ...last, timestamp: entry.timestamp }];
      }

      return [...prev, entry].slice(-MAX_STREAM_ACTIVITIES);
    });
  }, []);

  const handleMessage = useCallback((data: Record<string, unknown>) => {
    const type = data['type'] as string;

    switch (type) {
      case 'connected': {
        setMode(data['mode'] as SecurityMode);
        setSpicyEnabled(data['spicyEnabled'] as boolean);

        const llmState = data['llm'] as LLMState | undefined;
        if (llmState?.provider && llmState?.model) {
          setLlm(llmState);
        }
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
          setMessages((prev) => [...prev, {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `Error: ${error}`,
            timestamp: new Date(),
          }]);
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
        setMessages((prev) => [...prev, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `Error: ${message}`,
          timestamp: new Date(),
        }]);
        setPendingProviderSwitch(null);
        setModelsLoading(false);
        break;
      }

      case 'message_received':
        setIsStreaming(true);
        streamBufferRef.current = '';
        setStreamActivities([{
          id: crypto.randomUUID(),
          source: 'system',
          status: 'Starting model turn',
          detail: 'Waiting for live updates from the provider.',
          timestamp: new Date(),
        }]);
        break;

      case 'chunk': {
        const chunkContent = typeof data['content'] === 'string' ? data['content'] : '';
        streamBufferRef.current += chunkContent;
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant' && last.id === 'streaming') {
            return [...prev.slice(0, -1), { ...last, content: streamBufferRef.current }];
          }
          return [...prev, {
            id: 'streaming',
            role: 'assistant',
            content: streamBufferRef.current,
            timestamp: new Date(),
          }];
        });
        appendStreamActivity({
          source: 'system',
          status: 'Writing response',
        });
        break;
      }

      case 'stream_end':
        setIsStreaming(false);
        setStreamActivities([]);
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last?.id === 'streaming') {
            return [...prev.slice(0, -1), { ...last, id: crypto.randomUUID() }];
          }
          return [...prev, {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '(No response)',
            timestamp: new Date(),
          }];
        });
        break;

      case 'message':
        setIsStreaming(false);
        setStreamActivities([]);
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: data['content'] as string,
          timestamp: new Date(),
        }]);
        break;

      case 'tool_start': {
        const tool = data['tool'] as string;
        const args = asRecord(data['args']);
        setToolEvents(prev => [...prev, {
          id: crypto.randomUUID(),
          type: 'start',
          tool,
          args,
          timestamp: new Date(),
        }]);
        appendStreamActivity({
          source: 'tool',
          status: `Running ${tool}`,
          detail: summarizeToolArgs(args),
        });
        break;
      }

      case 'tool_end': {
        const tool = data['tool'] as string;
        const result = data['result'] as ToolEvent['result'] | undefined;
        setToolEvents(prev => [...prev, {
          id: crypto.randomUUID(),
          type: 'end',
          tool,
          result,
          timestamp: new Date(),
        }]);
        appendStreamActivity({
          source: 'tool',
          status: result?.success === false ? `Failed ${tool}` : `Finished ${tool}`,
          detail: summarizeToolResult(result),
        });
        break;
      }

      case 'provider_event': {
        const payload = asRecord(data['event']);
        const method = payload?.['method'];
        const params = asRecord(payload?.['params']);
        const activity = typeof method === 'string' ? getProviderStreamActivity(method, params) : null;
        const important = typeof method === 'string' ? isImportantProviderEvent(method, params) : false;

        setToolEvents(prev => [...prev, {
          id: crypto.randomUUID(),
          type: 'provider',
          tool: typeof method === 'string' ? method : 'provider/notification',
          args: params,
          detail: activity?.detail ?? (important ? 'Important provider event' : 'Codex app-server notification'),
          important,
          timestamp: new Date(),
        }]);

        if (activity) {
          appendStreamActivity(activity);
        }
        break;
      }

      case 'confirm_request':
        {
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

        setToolEvents(prev => [...prev, {
          id: crypto.randomUUID(),
          type: 'start',
          tool: parsedDetails?.tool ?? 'confirmation',
          args: parsedDetails?.args,
          detail: firstString(parsedDetails?.summary, data['prompt']) ?? 'Waiting for confirmation',
          timestamp: new Date(),
        }]);

        setPendingConfirmation({
          id: crypto.randomUUID(),
          prompt: data['prompt'] as string,
          details: parsedDetails,
        });
        appendStreamActivity({
          source: 'system',
          status: 'Waiting for your confirmation',
          detail: firstString(parsedDetails?.summary, data['prompt']),
        });
        break;
        }

      case 'mode_changed':
        setMode(data['mode'] as SecurityMode);
        break;

      case 'session_cleared':
        setMessages([]);
        setToolEvents([]);
        setStreamActivities([]);
        break;

      case 'error':
        setIsStreaming(false);
        setStreamActivities([]);
        setMessages(prev => {
          const error = data['error'];
          const content = typeof error === 'string' && error.trim()
            ? `Error: ${error}`
            : 'Error: Request failed';

          const last = prev[prev.length - 1];
          if (last?.id === 'streaming') {
            return [...prev.slice(0, -1), {
              ...last,
              id: crypto.randomUUID(),
              content,
            }];
          }

          return [...prev, {
            id: crypto.randomUUID(),
            role: 'assistant',
            content,
            timestamp: new Date(),
          }];
        });
        break;
    }
  }, [appendStreamActivity, pendingProviderSwitch]);

  const { send, connected, connecting } = useWebSocket(getWebSocketUrl(), handleMessage);

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
    if (!content.trim() || !connected) return;

    setMessages(prev => [...prev, {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: new Date(),
    }]);

    send({ type: 'message', content });
  }, [connected, send]);

  const handleConfirm = useCallback((decision: ConfirmationDecision) => {
    const confirmation = pendingConfirmation;
    send({ type: 'confirm_response', decision });
    setPendingConfirmation(null);
    if (!confirmation) {
      return;
    }

    const allowed = decision !== 'cancel';
    setToolEvents(prev => [...prev, {
      id: crypto.randomUUID(),
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
      timestamp: new Date(),
    }]);
  }, [pendingConfirmation, send]);

  const handleModeChange = useCallback((newMode: SecurityMode) => {
    if (newMode === 'spicy' && !spicyEnabled) {
      alert('Spicy mode is not enabled. Re-run the installer and accept the risk.');
      return;
    }
    send({ type: 'set_mode', mode: newMode });
  }, [send, spicyEnabled]);

  const handleClearSession = useCallback(() => {
    send({ type: 'clear_session' });
  }, [send]);

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
          <button className="btn-secondary" onClick={handleClearSession}>
            Clear session
          </button>
        </div>
      </header>

      <main className="app-main">
        <section className="chat-shell">
          <div className="chat-toolbar">
            <div className="llm-controls">
              <label className="llm-control">
                <span>Provider</span>
                <select
                  value={selectedProvider}
                  onChange={(event) => handleProviderChange(event.target.value as LLMProviderId)}
                  disabled={!connected || isStreaming}
                >
                  {PROVIDER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="llm-control">
                <span>Model</span>
                <select
                  value={selectedModelValue}
                  onChange={(event) => handleModelChange(event.target.value)}
                  disabled={!connected || isStreaming || selectedModels.length === 0 || modelsLoading}
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
                <label className="llm-control">
                  <span>Reasoning</span>
                  <select
                    value={selectedReasoningEffort ?? 'medium'}
                    onChange={(event) => handleReasoningEffortChange(event.target.value as CodexReasoningEffort)}
                    disabled={
                      !connected ||
                      isStreaming ||
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
            </div>
            {modelsLoading && (
              <span className="models-loading">Refreshing model catalog...</span>
            )}
          </div>

          <ChatView
            messages={messages}
            onSendMessage={handleSendMessage}
            isStreaming={isStreaming}
            streamActivities={streamActivities}
            disabled={!connected}
          />
        </section>

        <LiveActivityLog events={toolEvents} />
      </main>

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
