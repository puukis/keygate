import { spawn } from 'node:child_process';
import os from 'node:os';
import type {
  ChatOptions,
  CodexReasoningEffort,
  LLMChunk,
  LLMProvider,
  LLMResponse,
  Message,
  ProviderModelOption,
} from '../types.js';
import {
  CodexRpcClient,
  codexModelFromProviderModelId,
  mapCodexModelsToProviderModels,
  normalizeCodexModels,
  pickDefaultCodexModel,
  providerModelIdFromCodexModelId,
  readCodexModelCache,
  type CodexModel,
  type ProviderModel,
  writeCodexModelCache,
} from '../codex/index.js';
import type {
  CodexAccountReadResult,
  CodexLoginCompletedNotification,
  CodexLoginStartResult,
  CodexModelEntry,
  CodexModelListResult,
  CodexRpcNotification,
  CodexThreadStartResult,
  CodexTurnStartResult,
} from '../codex/index.js';

export interface OpenAICodexProviderOptions {
  cwd?: string;
  requestTimeoutMs?: number;
  reasoningEffort?: CodexReasoningEffort;
  rpcClient?: CodexRpcClient;
  openExternalUrl?: (url: string) => Promise<boolean>;
  allowDeviceAuthFallback?: boolean;
  loginTimeoutMs?: number;
}

interface LoginOptions {
  timeoutMs?: number;
  useDeviceAuth?: boolean;
  allowDeviceAuthFallback?: boolean;
}

export class OpenAICodexProvider implements LLMProvider {
  name = 'openai-codex';

  private readonly cwd: string;
  private readonly client: CodexRpcClient;
  private readonly openExternalUrl: (url: string) => Promise<boolean>;
  private readonly allowDeviceAuthFallback: boolean;
  private readonly loginTimeoutMs: number;
  private readonly reasoningEffort: CodexReasoningEffort;

  private selectedProviderModelId: string;
  private selectedCodexModelId: string | null = null;
  private cachedModels: CodexModel[] | null = null;
  private sessionThreadIds = new Map<string, string>();

  constructor(model: string, options: OpenAICodexProviderOptions = {}) {
    this.cwd = expandHomePath(options.cwd ?? process.cwd());
    this.selectedProviderModelId = model || 'openai-codex/gpt-5.3';
    this.reasoningEffort = normalizeCodexReasoningEffort(options.reasoningEffort) ?? 'medium';
    this.openExternalUrl = options.openExternalUrl ?? openExternalUrl;
    this.allowDeviceAuthFallback = options.allowDeviceAuthFallback ?? true;
    this.loginTimeoutMs = options.loginTimeoutMs ?? 240_000;

    this.client = options.rpcClient ?? new CodexRpcClient({
      cwd: this.cwd,
      requestTimeoutMs: options.requestTimeoutMs,
      modelReasoningEffort: this.reasoningEffort,
      clientInfo: {
        name: 'keygate',
        title: 'Keygate',
        version: '0.1.0',
      },
    });
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    let content = '';

    for await (const chunk of this.stream(messages, options)) {
      if (chunk.content) {
        content += chunk.content;
      }
    }

    return {
      content,
      finishReason: 'stop',
    };
  }

  async *stream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk> {
    await this.ensureConnected();
    await this.ensureAuthenticated(false);

    const sessionId = options?.sessionId ?? 'default';
    const hadThread = this.sessionThreadIds.has(sessionId);
    const threadId = await this.ensureThread(sessionId, options);
    const prompt = buildTurnPrompt(messages, !hadThread);

    const selectedModel = await this.resolveCodexModelId();

    const turnParams: Record<string, unknown> = {
      threadId,
      input: [{ type: 'text', text: prompt }],
      cwd: options?.cwd ?? this.cwd,
      model: selectedModel,
      approvalPolicy: normalizeApprovalPolicy(options?.approvalPolicy),
    };

    const sandboxPolicy = this.normalizeSandboxPolicy(
      options?.sandboxPolicy ?? this.getDefaultSandboxPolicy(options)
    );
    if (sandboxPolicy) {
      turnParams['sandboxPolicy'] = sandboxPolicy;
    }

    const turnStart = await this.client.request<CodexTurnStartResult>('turn/start', turnParams);
    const turnId = getTurnId(turnStart);

    if (!turnId) {
      throw new Error('Codex turn/start did not return a turn id');
    }

    const pendingChunks: LLMChunk[] = [];
    let done = false;
    let failed: Error | null = null;
    let wakeUp: (() => void) | null = null;
    let streamedText = '';

    const pushChunk = (chunk: LLMChunk): void => {
      pendingChunks.push(chunk);
      if (wakeUp) {
        const resolve = wakeUp;
        wakeUp = null;
        resolve();
      }
    };

    const onNotification = (notification: CodexRpcNotification): void => {
      if (!notificationBelongsToTurn(notification, turnId, threadId)) {
        return;
      }

      options?.onProviderEvent?.({
        provider: this.name,
        method: notification.method,
        params: notification.params,
      });

      if (notification.method === 'item/agentMessage/delta') {
        const deltaText = extractAgentDeltaText(notification.params);
        if (deltaText) {
          streamedText += deltaText;
          pushChunk({ content: deltaText, done: false });
        }
        return;
      }

      if (notification.method === 'item/completed') {
        const finalText = extractCompletedAgentMessageText(notification.params);
        if (finalText) {
          if (!streamedText) {
            streamedText = finalText;
            pushChunk({ content: finalText, done: false });
            return;
          }

          if (finalText.startsWith(streamedText)) {
            const tail = finalText.slice(streamedText.length);
            if (tail) {
              streamedText = finalText;
              pushChunk({ content: tail, done: false });
            }
            return;
          }

          if (finalText !== streamedText) {
            const separator = streamedText.endsWith('\n') ? '' : '\n';
            streamedText += `${separator}${finalText}`;
            pushChunk({ content: `${separator}${finalText}`, done: false });
          }
        }
        return;
      }

      if (notification.method === 'turn/completed') {
        const status = getTurnStatus(notification.params);

        if (status === 'failed') {
          failed = new Error(getTurnFailureMessage(notification.params) ?? 'Codex turn failed');
        }

        done = true;
        if (wakeUp) {
          const resolve = wakeUp;
          wakeUp = null;
          resolve();
        }
      }
    };

    this.client.on('notification', onNotification);

    try {
      while (!done || pendingChunks.length > 0) {
        if (pendingChunks.length > 0) {
          yield pendingChunks.shift()!;
          continue;
        }

        if (failed) {
          throw failed;
        }

        await new Promise<void>((resolve) => {
          wakeUp = resolve;
        });
      }

      if (failed) {
        throw failed;
      }

      yield { done: true };
    } finally {
      this.client.off('notification', onNotification);
    }
  }

  async listModels(): Promise<ProviderModelOption[]> {
    const codexModels = await this.listCodexModels();

    return mapCodexModelsToProviderModels(codexModels).map((model) => toProviderModelOption(model));
  }

  getModel(): string {
    return this.selectedProviderModelId;
  }

  async setModel(model: string): Promise<void> {
    this.selectedProviderModelId = model;
    this.selectedCodexModelId = null;
    this.sessionThreadIds.clear();
  }

  async login(options: LoginOptions = {}): Promise<void> {
    await this.ensureConnected();

    const accountState = await this.readAccount();
    if (hasActiveAccount(accountState)) {
      return;
    }

    if (options.useDeviceAuth) {
      await runCodexDeviceAuth();
      await this.ensureAuthenticated(false, true);
      return;
    }

    const loginStart = await this.client.request<CodexLoginStartResult>('account/login/start', {
      type: 'chatgpt',
    });

    const loginId = loginStart.loginId;
    const authUrl = loginStart.authUrl;

    if (!authUrl) {
      throw new Error('Codex account/login/start did not return authUrl for ChatGPT login');
    }

    const opened = await this.openExternalUrl(authUrl);

    if (!opened) {
      const shouldFallback = options.allowDeviceAuthFallback ?? this.allowDeviceAuthFallback;
      if (!shouldFallback) {
        throw new Error('Unable to open browser for ChatGPT OAuth. Retry with --device-auth.');
      }

      await runCodexDeviceAuth();
      await this.ensureAuthenticated(false, true);
      return;
    }

    const timeoutMs = options.timeoutMs ?? this.loginTimeoutMs;
    const completion = await this.client.waitForNotification('account/login/completed', {
      timeoutMs,
      predicate: (params) => {
        if (!loginId) {
          return true;
        }
        return params?.['loginId'] === loginId;
      },
    });

    const completed = completion as CodexLoginCompletedNotification | undefined;

    if (completed?.success === false) {
      throw new Error(completed.error ?? 'ChatGPT OAuth login failed in Codex');
    }

    await this.ensureAuthenticated(false, true);
  }

  async dispose(): Promise<void> {
    await this.client.stop();
  }

  async checkAccount(): Promise<CodexAccountReadResult> {
    await this.ensureConnected();
    return this.readAccount();
  }

  async ensureAuthenticated(autoLogin = false, refreshToken = false): Promise<void> {
    const account = await this.readAccount(refreshToken);

    if (hasActiveAccount(account)) {
      return;
    }

    if (!account.requiresOpenaiAuth) {
      return;
    }

    if (autoLogin) {
      await this.login();
      return;
    }

    throw new Error('Not logged in to Codex. Run `keygate auth login --provider openai-codex` first.');
  }

  private async ensureConnected(): Promise<void> {
    await this.client.ensureInitialized();
  }

  private async listCodexModels(): Promise<CodexModel[]> {
    try {
      await this.ensureConnected();
      const discovered = await this.listCodexModelsFromServer();
      this.cachedModels = discovered;
      await writeCodexModelCache(discovered);
      return discovered;
    } catch {
      if (this.cachedModels && this.cachedModels.length > 0) {
        return this.cachedModels;
      }

      const fromDisk = await readCodexModelCache();
      if (fromDisk && fromDisk.length > 0) {
        this.cachedModels = fromDisk;
        return fromDisk;
      }

      const fallback = normalizeCodexModels([]);
      this.cachedModels = fallback;
      return fallback;
    }
  }

  private async listCodexModelsFromServer(): Promise<CodexModel[]> {
    const entries: CodexModelEntry[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 8; page += 1) {
      const params = cursor
        ? { limit: 100, cursor }
        : { limit: 100 };

      const result = await this.client.request<CodexModelListResult>('model/list', params);
      if (Array.isArray(result.data)) {
        entries.push(...result.data);
      }

      if (!result.nextCursor) {
        break;
      }

      cursor = result.nextCursor;
    }

    const normalized = normalizeCodexModels(entries);

    const deduped = new Map<string, CodexModel>();
    for (const model of normalized) {
      deduped.set(model.id, model);
    }

    return Array.from(deduped.values());
  }

  private async readAccount(refreshToken = false): Promise<CodexAccountReadResult> {
    try {
      return await this.client.request<CodexAccountReadResult>('account/read', { refreshToken });
    } catch {
      if (refreshToken) {
        return this.client.request<CodexAccountReadResult>('account/read');
      }

      throw new Error('Failed to read Codex account state');
    }
  }

  private async ensureThread(sessionId: string, options?: ChatOptions): Promise<string> {
    const existing = this.sessionThreadIds.get(sessionId);
    if (existing) {
      return existing;
    }

    const modelId = await this.resolveCodexModelId();

    const threadParams: Record<string, unknown> = {
      model: modelId,
      cwd: options?.cwd ?? this.cwd,
      approvalPolicy: normalizeApprovalPolicy(options?.approvalPolicy),
      sandbox: options?.securityMode === 'spicy' ? 'danger-full-access' : 'workspace-write',
    };

    const startResult = await this.client.request<CodexThreadStartResult>('thread/start', threadParams);
    const threadId = startResult.thread?.id ?? startResult.threadId;

    if (!threadId) {
      throw new Error('Codex thread/start did not return a thread id');
    }

    this.sessionThreadIds.set(sessionId, threadId);
    return threadId;
  }

  private async resolveCodexModelId(): Promise<string> {
    if (this.selectedCodexModelId) {
      return this.selectedCodexModelId;
    }

    const models = await this.listCodexModels();

    if (!this.selectedProviderModelId) {
      const defaultModel = pickDefaultCodexModel(models);
      this.selectedCodexModelId = defaultModel.id;
      this.selectedProviderModelId = providerModelIdFromCodexModelId(defaultModel.id);
      return defaultModel.id;
    }

    const codexId = codexModelFromProviderModelId(this.selectedProviderModelId, models);
    this.selectedCodexModelId = codexId;

    if (!this.selectedProviderModelId.startsWith('openai-codex/')) {
      this.selectedProviderModelId = providerModelIdFromCodexModelId(codexId);
    }

    return codexId;
  }

  private getDefaultSandboxPolicy(options?: ChatOptions): Record<string, unknown> | undefined {
    if (options?.securityMode === 'spicy') {
      return { type: 'dangerFullAccess' };
    }

    const workspace = options?.cwd ?? this.cwd;
    return {
      type: 'workspaceWrite',
      writable_roots: [workspace],
      network_access: true,
    };
  }

  private normalizeSandboxPolicy(
    sandboxPolicy: Record<string, unknown> | undefined
  ): Record<string, unknown> | undefined {
    if (!sandboxPolicy) {
      return undefined;
    }

    const normalized: Record<string, unknown> = { ...sandboxPolicy };

    // Codex expects sandbox policy discriminated by `type`.
    // Keep compatibility with legacy callers that still pass `mode`.
    if (typeof normalized['type'] === 'string') {
      normalized['type'] = normalizeTurnSandboxPolicyType(normalized['type']);
    } else if (typeof normalized['mode'] === 'string') {
      normalized['type'] = normalizeTurnSandboxPolicyType(normalized['mode']);
    }

    if (!normalized['writable_roots'] && Array.isArray(normalized['writableRoots'])) {
      normalized['writable_roots'] = normalized['writableRoots'];
    }

    if (typeof normalized['network_access'] !== 'boolean' && typeof normalized['networkAccess'] === 'boolean') {
      normalized['network_access'] = normalized['networkAccess'];
    }

    if (typeof normalized['exclude_slash_tmp'] !== 'boolean' && typeof normalized['excludeSlashTmp'] === 'boolean') {
      normalized['exclude_slash_tmp'] = normalized['excludeSlashTmp'];
    }

    if (
      typeof normalized['exclude_tmpdir_env_var'] !== 'boolean' &&
      typeof normalized['excludeTmpdirEnvVar'] === 'boolean'
    ) {
      normalized['exclude_tmpdir_env_var'] = normalized['excludeTmpdirEnvVar'];
    }

    delete normalized['mode'];
    delete normalized['writableRoots'];
    delete normalized['networkAccess'];
    delete normalized['excludeSlashTmp'];
    delete normalized['excludeTmpdirEnvVar'];

    return normalized;
  }
}

export async function runCodexDeviceAuth(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('codex', ['login', '--device-auth'], {
      stdio: 'inherit',
    });

    child.once('error', (error) => {
      reject(new Error(`Failed to start device auth login: ${error.message}`));
    });

    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`codex login --device-auth exited with code ${code}`));
    });
  });
}

function hasActiveAccount(accountState: CodexAccountReadResult): boolean {
  return Boolean(accountState.account);
}

function getLatestUserPrompt(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') {
      return message.content;
    }
  }

  throw new Error('No user message found for Codex turn/start');
}

function buildTurnPrompt(messages: Message[], includeSystemContext: boolean): string {
  const latestUserPrompt = getLatestUserPrompt(messages);

  if (!includeSystemContext) {
    return latestUserPrompt;
  }

  const systemParts = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0);

  if (systemParts.length === 0) {
    return latestUserPrompt;
  }

  return [
    'SYSTEM INSTRUCTIONS (higher priority than user messages):',
    systemParts.join('\n\n'),
    '',
    'USER MESSAGE:',
    latestUserPrompt,
  ].join('\n');
}

function getTurnId(result: CodexTurnStartResult): string | undefined {
  return result.turn?.id ?? result.turnId;
}

function getTurnStatus(params: Record<string, unknown> | undefined): string | undefined {
  const turn = params?.['turn'];
  if (!turn || typeof turn !== 'object') {
    return undefined;
  }

  const status = (turn as Record<string, unknown>)['status'];
  return typeof status === 'string' ? status : undefined;
}

function getTurnFailureMessage(params: Record<string, unknown> | undefined): string | undefined {
  const turn = params?.['turn'];
  if (!turn || typeof turn !== 'object') {
    return undefined;
  }

  const error = (turn as Record<string, unknown>)['error'];
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const message = (error as Record<string, unknown>)['message'];
  return typeof message === 'string' ? message : undefined;
}

function notificationBelongsToTurn(
  notification: CodexRpcNotification,
  turnId: string,
  threadId: string
): boolean {
  const params = notification.params;
  if (!params) {
    return false;
  }

  const paramsRecord = params as Record<string, unknown>;

  const directTurnId = paramsRecord['turnId'];
  if (typeof directTurnId === 'string' && directTurnId !== turnId) {
    return false;
  }

  const directThreadId = paramsRecord['threadId'];
  if (typeof directThreadId === 'string' && directThreadId !== threadId) {
    return false;
  }

  const nestedTurn = paramsRecord['turn'];
  if (nestedTurn && typeof nestedTurn === 'object') {
    const nestedTurnId = (nestedTurn as Record<string, unknown>)['id'];
    if (typeof nestedTurnId === 'string' && nestedTurnId !== turnId) {
      return false;
    }
  }

  const nestedItem = paramsRecord['item'];
  if (nestedItem && typeof nestedItem === 'object') {
    const itemTurnId = (nestedItem as Record<string, unknown>)['turnId'];
    if (typeof itemTurnId === 'string' && itemTurnId !== turnId) {
      return false;
    }

    const itemThreadId = (nestedItem as Record<string, unknown>)['threadId'];
    if (typeof itemThreadId === 'string' && itemThreadId !== threadId) {
      return false;
    }
  }

  return true;
}

function extractAgentDeltaText(params: Record<string, unknown> | undefined): string {
  if (!params) {
    return '';
  }

  const directDelta = params['delta'];

  if (typeof directDelta === 'string') {
    return directDelta;
  }

  if (directDelta && typeof directDelta === 'object') {
    const text = (directDelta as Record<string, unknown>)['text'];
    if (typeof text === 'string') {
      return text;
    }
  }

  const item = params['item'];
  if (item && typeof item === 'object') {
    const itemDelta = (item as Record<string, unknown>)['delta'];
    if (typeof itemDelta === 'string') {
      return itemDelta;
    }

    if (itemDelta && typeof itemDelta === 'object') {
      const text = (itemDelta as Record<string, unknown>)['text'];
      if (typeof text === 'string') {
        return text;
      }
    }
  }

  return '';
}

function extractCompletedAgentMessageText(params: Record<string, unknown> | undefined): string {
  if (!params) {
    return '';
  }

  const item = params['item'];
  if (!item || typeof item !== 'object') {
    return '';
  }

  const itemRecord = item as Record<string, unknown>;
  const itemType = itemRecord['type'];
  if (itemType !== 'agentMessage') {
    return '';
  }

  const text = itemRecord['text'];
  if (typeof text === 'string') {
    return text;
  }

  const content = itemRecord['content'];
  if (!Array.isArray(content)) {
    return '';
  }

  const fragments: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') {
      continue;
    }

    const partRecord = part as Record<string, unknown>;
    const value = partRecord['text'];
    if (typeof value === 'string') {
      fragments.push(value);
    }
  }

  return fragments.join('');
}

function toProviderModelOption(model: ProviderModel): ProviderModelOption {
  return {
    id: model.id,
    provider: model.provider,
    displayName: model.displayName,
    isDefault: model.isDefault,
    supportsPersonality: model.supportsPersonality,
    reasoningEffort: model.reasoningEffort,
    defaultReasoningEffort: model.defaultReasoningEffort,
    metadata: {
      codexModelId: model.codexModelId,
    },
  };
}

async function openExternalUrl(url: string): Promise<boolean> {
  const platform = process.platform;

  const command =
    platform === 'darwin'
      ? { cmd: 'open', args: [url] }
      : platform === 'win32'
        ? { cmd: 'cmd', args: ['/c', 'start', '', url] }
        : { cmd: 'xdg-open', args: [url] };

  return new Promise<boolean>((resolve) => {
    const child = spawn(command.cmd, command.args, {
      stdio: 'ignore',
      detached: platform !== 'win32',
    });

    child.once('error', () => {
      resolve(false);
    });

    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

function expandHomePath(value: string): string {
  if (value === '~') {
    return os.homedir();
  }

  if (value.startsWith('~/')) {
    return `${os.homedir()}${value.slice(1)}`;
  }

  return value;
}

function normalizeCodexReasoningEffort(value: unknown): CodexReasoningEffort | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  switch (normalized) {
    case 'low':
    case 'medium':
    case 'high':
      return normalized;
    case 'xhigh':
    case 'extra-high':
    case 'extra_high':
    case 'extra high':
      return 'xhigh';
    default:
      return null;
  }
}

function normalizeApprovalPolicy(value: unknown): 'untrusted' | 'on-failure' | 'on-request' | 'never' {
  if (typeof value !== 'string') {
    return 'untrusted';
  }

  const normalized = value.trim().toLowerCase();

  switch (normalized) {
    case 'untrusted':
    case 'unlesstrusted':
    case 'unless-trusted':
    case 'unless_trusted':
      return 'untrusted';
    case 'on-failure':
    case 'on_failure':
    case 'onfailure':
      return 'on-failure';
    case 'on-request':
    case 'on_request':
    case 'onrequest':
      return 'on-request';
    case 'never':
      return 'never';
    default:
      return 'untrusted';
  }
}

function normalizeTurnSandboxPolicyType(
  value: string
): 'dangerFullAccess' | 'readOnly' | 'externalSandbox' | 'workspaceWrite' {
  const normalized = value.trim().toLowerCase();

  switch (normalized) {
    case 'dangerfullaccess':
    case 'danger-full-access':
    case 'danger_full_access':
      return 'dangerFullAccess';
    case 'readonly':
    case 'read-only':
    case 'read_only':
      return 'readOnly';
    case 'externalsandbox':
    case 'external-sandbox':
    case 'external_sandbox':
      return 'externalSandbox';
    case 'workspacewrite':
    case 'workspace-write':
    case 'workspace_write':
      return 'workspaceWrite';
    default:
      return 'workspaceWrite';
  }
}
