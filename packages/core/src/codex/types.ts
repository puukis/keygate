export type JsonRpcId = number | string;

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: TParams;
}

export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc?: '2.0';
  id: JsonRpcId;
  result: TResult;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc?: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export interface CodexInitializeParams {
  clientInfo: {
    name: string;
    title: string;
    version: string;
  };
}

export interface CodexInitializeResult {
  sessionId?: string;
  [key: string]: unknown;
}

export interface CodexAccount {
  type?: string;
  email?: string;
  [key: string]: unknown;
}

export interface CodexAccountReadResult {
  account?: CodexAccount | null;
  requiresOpenaiAuth?: boolean;
  [key: string]: unknown;
}

export interface CodexLoginStartParams {
  type: 'chatgpt';
}

export interface CodexLoginStartResult {
  loginId?: string;
  authUrl?: string;
  [key: string]: unknown;
}

export interface CodexLoginCompletedNotification {
  loginId?: string;
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface CodexModelEntry {
  id?: string;
  model?: string;
  displayName?: string;
  isDefault?: boolean;
  supportsPersonality?: boolean;
  reasoningEffort?: unknown;
  defaultReasoningEffort?: string;
  [key: string]: unknown;
}

export interface CodexModelListResult {
  data?: CodexModelEntry[];
  nextCursor?: string | null;
  [key: string]: unknown;
}

export interface CodexThreadStartResult {
  threadId?: string;
  thread?: {
    id?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CodexTurnStartResult {
  turnId?: string;
  turn?: {
    id?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CodexRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}
