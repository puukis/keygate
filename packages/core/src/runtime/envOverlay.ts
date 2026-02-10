import { AsyncLocalStorage } from 'node:async_hooks';

const envOverlayStorage = new AsyncLocalStorage<Record<string, string>>();

export async function withEnvOverlay<T>(
  envOverlay: Record<string, string>,
  callback: () => Promise<T>
): Promise<T> {
  return envOverlayStorage.run({ ...envOverlay }, callback);
}

export function getEnvOverlay(): Record<string, string> {
  return envOverlayStorage.getStore() ?? {};
}

export function getEnvValue(name: string): string | undefined {
  const processValue = process.env[name];
  if (typeof processValue === 'string' && processValue.length > 0) {
    return processValue;
  }

  const overlayValue = getEnvOverlay()[name];
  if (typeof overlayValue === 'string' && overlayValue.length > 0) {
    return overlayValue;
  }

  return undefined;
}

export function buildToolProcessEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...getEnvOverlay(),
    ...extra,
  };
}
