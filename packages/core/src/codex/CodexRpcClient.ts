import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import * as readline from 'node:readline';
import EventEmitter from 'eventemitter3';
import type {
  CodexInitializeParams,
  CodexInitializeResult,
  CodexRpcNotification,
  JsonRpcErrorResponse,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
} from './types.js';

interface PendingRequest {
  method: string;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

type SpawnFactory = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

interface CodexRpcClientEvents {
  notification: (notification: CodexRpcNotification) => void;
  stderr: (line: string) => void;
  exit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

export interface CodexRpcClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  modelReasoningEffort?: string;
  requestTimeoutMs?: number;
  spawnFactory?: SpawnFactory;
  clientInfo?: CodexInitializeParams['clientInfo'];
}

export class CodexRpcClient extends EventEmitter<CodexRpcClientEvents> {
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd?: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly modelReasoningEffort?: string;
  private readonly requestTimeoutMs: number;
  private readonly spawnFactory: SpawnFactory;
  private readonly clientInfo: CodexInitializeParams['clientInfo'];

  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutReadline: readline.Interface | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private initialized = false;
  private closing = false;
  private stderrLines: string[] = [];
  private attemptedReasoningEffortCompat = false;
  private useReasoningEffortCompatOverride = false;

  constructor(options: CodexRpcClientOptions = {}) {
    super();
    this.command = options.command ?? 'codex';
    this.args = options.args ?? ['app-server'];
    this.cwd = options.cwd;
    this.env = options.env;
    this.modelReasoningEffort = normalizeModelReasoningEffort(options.modelReasoningEffort);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 90_000;
    this.spawnFactory = options.spawnFactory ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.clientInfo = options.clientInfo ?? {
      name: 'keygate',
      title: 'Keygate',
      version: '0.1.0',
    };
  }

  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    const child = this.spawnFactory(this.command, this.resolveSpawnArgs(), {
      cwd: this.cwd,
      env: {
        ...process.env,
        ...this.env,
      },
      stdio: 'pipe',
    });

    this.process = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    this.stdoutReadline = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    this.stdoutReadline.on('line', (line) => {
      this.handleStdoutLine(line);
    });

    child.stderr.on('data', (chunk) => {
      this.handleStderrChunk(String(chunk));
    });

    child.on('exit', (code, signal) => {
      this.handleProcessExit(code, signal);
    });

    child.on('error', (error) => {
      this.failPendingRequests(new Error(`Failed to start Codex app-server: ${error.message}`));
    });
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    this.closing = true;
    const child = this.process;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 3_000);

      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      child.kill('SIGTERM');
    });

    this.cleanupProcessState();
    this.initialized = false;
    this.closing = false;
  }

  async initialize(params?: CodexInitializeParams): Promise<CodexInitializeResult> {
    await this.start();

    const initializeResult = await this.request<CodexInitializeResult>('initialize', {
      clientInfo: params?.clientInfo ?? this.clientInfo,
    });

    this.notify('initialized', {});
    this.initialized = true;

    return initializeResult;
  }

  async ensureInitialized(params?: CodexInitializeParams): Promise<void> {
    if (this.initialized && this.process) {
      return;
    }

    try {
      await this.initialize(params);
    } catch (error) {
      if (!this.shouldRetryWithReasoningEffortCompat(error)) {
        throw error;
      }

      this.attemptedReasoningEffortCompat = true;
      this.useReasoningEffortCompatOverride = true;

      await this.stop();
      await this.initialize(params);
    }
  }

  async request<TResult = unknown, TParams = unknown>(method: string, params?: TParams): Promise<TResult> {
    this.assertProcessRunning();

    const requestId = this.nextRequestId++;

    const payload: JsonRpcRequest<TParams> = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      params,
    };

    const line = `${JSON.stringify(payload)}\n`;

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Codex request timed out (${method}) after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(requestId, {
        method,
        timer,
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      this.process!.stdin.write(line, (error) => {
        if (!error) {
          return;
        }

        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        reject(new Error(`Failed to write Codex request (${method}): ${error.message}`));
      });
    });
  }

  notify<TParams = unknown>(method: string, params?: TParams): void {
    this.assertProcessRunning();

    const payload = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.process!.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async waitForNotification(
    method: string,
    options: {
      timeoutMs?: number;
      predicate?: (params: Record<string, unknown> | undefined) => boolean;
    } = {}
  ): Promise<Record<string, unknown> | undefined> {
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;

    return new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('notification', onNotification);
        reject(new Error(`Timed out waiting for Codex notification: ${method}`));
      }, timeoutMs);

      const onNotification = (notification: CodexRpcNotification) => {
        if (notification.method !== method) {
          return;
        }

        const params = notification.params;
        if (options.predicate && !options.predicate(params)) {
          return;
        }

        clearTimeout(timeout);
        this.off('notification', onNotification);
        resolve(params);
      };

      this.on('notification', onNotification);
    });
  }

  getRecentStderr(maxLines = 20): string[] {
    if (maxLines <= 0) {
      return [];
    }

    return this.stderrLines.slice(-maxLines);
  }

  private resolveSpawnArgs(): string[] {
    const args = [...this.args];

    const isAppServerInvocation = args.some((value) => value === 'app-server');
    if (!isAppServerInvocation) {
      return args;
    }

    if (this.useReasoningEffortCompatOverride) {
      return withModelReasoningEffortOverride(args, 'high');
    }

    if (this.modelReasoningEffort) {
      return withModelReasoningEffortOverride(args, this.modelReasoningEffort);
    }

    return args;
  }

  private shouldRetryWithReasoningEffortCompat(error: unknown): boolean {
    if (this.attemptedReasoningEffortCompat) {
      return false;
    }

    const message = error instanceof Error ? error.message : String(error);
    const stderr = this.getRecentStderr(40).join('\n');
    const combined = `${message}\n${stderr}`.toLowerCase();

    return (
      combined.includes('model_reasoning_effort') &&
      combined.includes('unknown variant')
    );
  }

  private handleStdoutLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      return;
    }

    const value = parsed as Record<string, unknown>;

    const hasId = typeof value['id'] === 'number';
    const hasMethod = typeof value['method'] === 'string';

    if (isSuccessResponse(value)) {
      this.handleResponse(value);
      return;
    }

    if (isErrorResponse(value)) {
      this.handleErrorResponse(value);
      return;
    }

    if (!hasId && hasMethod) {
      this.emit('notification', {
        method: value['method'] as string,
        params: value['params'] as Record<string, unknown> | undefined,
      });
    }
  }

  private handleResponse(response: JsonRpcSuccessResponse<unknown>): void {
    const requestId = response.id;
    const pending = this.pendingRequests.get(requestId);

    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);
    pending.resolve(response.result);
  }

  private handleErrorResponse(response: JsonRpcErrorResponse): void {
    const requestId = response.id;
    const pending = this.pendingRequests.get(requestId);

    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);

    const errorMessage = response.error?.message ?? 'Unknown Codex RPC error';
    const code = response.error?.code;

    pending.reject(new Error(`Codex request failed (${pending.method}): [${code}] ${errorMessage}`));
  }

  private handleStderrChunk(chunk: string): void {
    const lines = chunk
      .split(/\r?\n/g)
      .map((line) => scrubPotentialSecrets(line))
      .filter((line) => line.trim().length > 0);

    if (lines.length === 0) {
      return;
    }

    for (const line of lines) {
      this.stderrLines.push(line);
      if (this.stderrLines.length > 200) {
        this.stderrLines.shift();
      }
      this.emit('stderr', line);
    }
  }

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('exit', { code, signal });

    if (!this.closing) {
      const stderr = this.getRecentStderr(6).join('\n');
      const suffix = stderr ? `\nRecent stderr:\n${stderr}` : '';
      this.failPendingRequests(new Error(`Codex app-server exited unexpectedly (code=${code}, signal=${signal})${suffix}`));
    }

    this.cleanupProcessState();
    this.initialized = false;
  }

  private cleanupProcessState(): void {
    if (this.stdoutReadline) {
      this.stdoutReadline.removeAllListeners();
      this.stdoutReadline.close();
      this.stdoutReadline = null;
    }

    if (this.process) {
      this.process.removeAllListeners();
      this.process.stdout.removeAllListeners();
      this.process.stderr.removeAllListeners();
      this.process = null;
    }
  }

  private failPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }

    this.pendingRequests.clear();
  }

  private assertProcessRunning(): void {
    if (!this.process) {
      throw new Error('Codex app-server process is not running');
    }
  }
}

function scrubPotentialSecrets(value: string): string {
  if (!value) {
    return value;
  }

  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/g, '$1[REDACTED]')
    .replace(/("?(?:token|access_token|refresh_token|id_token|apiKey|api_key|authorization)"?\s*[:=]\s*"?)[^"\s]+/gi, '$1[REDACTED]');
}

function isSuccessResponse(value: unknown): value is JsonRpcSuccessResponse<unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const row = value as Record<string, unknown>;
  return typeof row['id'] === 'number' && Object.prototype.hasOwnProperty.call(row, 'result');
}

function isErrorResponse(value: unknown): value is JsonRpcErrorResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const row = value as Record<string, unknown>;
  return typeof row['id'] === 'number' && Object.prototype.hasOwnProperty.call(row, 'error');
}

function withModelReasoningEffortOverride(args: string[], effort: string): string[] {
  const override = `model_reasoning_effort="${effort}"`;
  const updated: string[] = [];
  let replaced = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;

    if ((arg === '-c' || arg === '--config') && i + 1 < args.length) {
      const value = args[i + 1]!;
      if (/^\s*model_reasoning_effort\s*=/.test(value)) {
        if (!replaced) {
          updated.push(arg, override);
          replaced = true;
        }
        i += 1;
        continue;
      }

      updated.push(arg, value);
      i += 1;
      continue;
    }

    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (/^\s*model_reasoning_effort\s*=/.test(value)) {
        if (!replaced) {
          updated.push(`--config=${override}`);
          replaced = true;
        }
        continue;
      }
    }

    updated.push(arg);
  }

  if (!replaced) {
    updated.push('-c', override);
  }

  return updated;
}

function normalizeModelReasoningEffort(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  switch (normalized) {
    case 'low':
    case 'medium':
    case 'high':
      return normalized;
    case 'xhigh':
      return 'high';
    case 'extra-high':
    case 'extra_high':
    case 'extra high':
      // Current Codex variants top out at "high".
      return 'high';
    default:
      return undefined;
  }
}
