import type { Gateway } from '../gateway/index.js';
import type { CanvasStateMode } from '../types.js';
import type { CanvasHostHandler } from './host.js';

export interface CanvasOpenInput {
  sessionId: string;
  surfaceId: string;
  path: string;
  state?: unknown;
  statusText?: string;
}

export interface CanvasUpdateInput {
  sessionId: string;
  surfaceId: string;
  path?: string;
  mode?: CanvasStateMode;
  state?: unknown;
  statusText?: string;
}

export interface CanvasCloseInput {
  sessionId: string;
  surfaceId: string;
}

class CanvasRuntime {
  private gateway: Gateway | null = null;
  private host: CanvasHostHandler | null = null;

  configure(params: { gateway: Gateway; host: CanvasHostHandler }): void {
    this.gateway = params.gateway;
    this.host = params.host;
  }

  async open(input: CanvasOpenInput): Promise<void> {
    const gateway = this.requireGateway();
    gateway.db.upsertCanvasSurface({
      sessionId: input.sessionId,
      surfaceId: input.surfaceId,
      path: input.path,
      state: normalizeCanvasState(input.state),
      statusText: input.statusText,
    });
    this.publish({
      sessionId: input.sessionId,
      surfaceId: input.surfaceId,
      path: input.path,
      mode: 'replace',
      state: input.state,
      statusText: input.statusText,
    });
  }

  async update(input: CanvasUpdateInput): Promise<void> {
    const gateway = this.requireGateway();
    const existing = gateway.db.getCanvasSurface(input.sessionId, input.surfaceId);
    const nextPath = input.path ?? existing?.path ?? '/__keygate__/a2ui';
    const nextState = input.mode === 'patch'
      ? mergeCanvasState(existing?.state, input.state)
      : input.state;
    gateway.db.upsertCanvasSurface({
      sessionId: input.sessionId,
      surfaceId: input.surfaceId,
      path: nextPath,
      state: normalizeCanvasState(nextState),
      statusText: input.statusText ?? existing?.statusText,
    });
    this.publish({
      sessionId: input.sessionId,
      surfaceId: input.surfaceId,
      path: nextPath,
      mode: input.mode ?? 'replace',
      state: nextState,
      statusText: input.statusText ?? existing?.statusText,
    });
  }

  async close(input: CanvasCloseInput): Promise<void> {
    const gateway = this.requireGateway();
    gateway.db.deleteCanvasSurface(input.sessionId, input.surfaceId);
    gateway.emit('canvas:close', {
      sessionId: input.sessionId,
      surfaceId: input.surfaceId,
    });
  }

  private publish(event: {
    sessionId: string;
    surfaceId: string;
    path: string;
    mode: CanvasStateMode;
    state?: unknown;
    statusText?: string;
  }): void {
    const gateway = this.requireGateway();
    gateway.emit('canvas:state', event);
    this.host?.broadcastState(event);
  }

  private requireGateway(): Gateway {
    if (!this.gateway) {
      throw new Error('Canvas runtime is not configured.');
    }
    return this.gateway;
  }
}

const globalCanvasRuntime = new CanvasRuntime();

export function getCanvasRuntime(): CanvasRuntime {
  return globalCanvasRuntime;
}

function mergeCanvasState(previous: unknown, next: unknown): unknown {
  if (!isPlainObject(previous) || !isPlainObject(next)) {
    return next;
  }
  return {
    ...previous,
    ...next,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCanvasState(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (isPlainObject(value)) {
    return value;
  }
  return {
    value,
  };
}
