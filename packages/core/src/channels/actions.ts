import type { ChannelActionName, ChannelType } from '../types.js';

export interface ChannelActionResult {
  ok: boolean;
  channel: ChannelType | 'webchat';
  accountId?: string;
  externalMessageId?: string;
  threadId?: string;
  pollId?: string;
  payload?: Record<string, unknown>;
  error?: string;
}

export interface ChannelActionContext {
  sessionId: string;
  action: ChannelActionName;
  params: Record<string, unknown>;
}

export interface ChannelActionAdapter {
  channel: ChannelType | 'webchat';
  actions: ChannelActionName[];
  handle(ctx: ChannelActionContext): Promise<ChannelActionResult>;
}

export type ChannelActionDispatchObserver = (event: {
  channel: ChannelType | 'webchat';
  context: ChannelActionContext;
  result: ChannelActionResult;
}) => void | Promise<void>;

export class ChannelActionRegistry {
  private readonly adapters = new Map<string, ChannelActionAdapter>();
  private observer: ChannelActionDispatchObserver | null = null;

  register(adapter: ChannelActionAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }

  unregister(channel: ChannelType | 'webchat'): void {
    this.adapters.delete(channel);
  }

  listChannels(): Array<ChannelType | 'webchat'> {
    return Array.from(this.adapters.keys()) as Array<ChannelType | 'webchat'>;
  }

  listActions(channel: ChannelType | 'webchat'): ChannelActionName[] {
    return this.adapters.get(channel)?.actions ?? [];
  }

  setObserver(observer: ChannelActionDispatchObserver | null): void {
    this.observer = observer;
  }

  async dispatch(channel: ChannelType | 'webchat', ctx: ChannelActionContext): Promise<ChannelActionResult> {
    const adapter = this.adapters.get(channel);
    if (!adapter) {
      return {
        ok: false,
        channel,
        error: `No action adapter registered for ${channel}.`,
      };
    }
    if (!adapter.actions.includes(ctx.action)) {
      return {
        ok: false,
        channel,
        error: `${ctx.action} is not supported for ${channel}.`,
      };
    }
    const normalized = await adapter.handle(ctx);
    if (this.observer) {
      await this.observer({
        channel,
        context: ctx,
        result: normalized,
      });
    }
    return normalized;
  }
}

const globalRegistry = new ChannelActionRegistry();

export function getChannelActionRegistry(): ChannelActionRegistry {
  return globalRegistry;
}
