import type { Gateway } from '../gateway/Gateway.js';
import type { KeygateEvents } from '../types.js';
import type { PluginEventsApi, PluginStage } from './types.js';

export function createPluginEventsApi(gateway: Gateway, stage: PluginStage): PluginEventsApi {
  return {
    on(eventName, listener) {
      const typedListener = listener as (payload: KeygateEvents[keyof KeygateEvents]) => void;
      gateway.on(eventName, typedListener as never);
      stage.eventSubscriptions.push({
        eventName,
        listener: typedListener,
      });
    },
  };
}
