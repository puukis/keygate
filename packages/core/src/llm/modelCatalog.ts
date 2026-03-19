import type { KeygateConfig, ProviderModelOption } from '../types.js';

const BUILT_IN_MODELS: Record<KeygateConfig['llm']['provider'], readonly string[]> = {
  openai: ['gpt-4o', 'gpt-4.1', 'o3-mini'],
  gemini: ['gemini-1.5-pro', 'gemini-1.5-flash'],
  ollama: ['llama3', 'qwen2.5-coder'],
  'openai-codex': ['openai-codex/gpt-5.3', 'openai-codex/gpt-5.2'],
};

export function getDefaultModelForProvider(provider: KeygateConfig['llm']['provider']): string {
  return BUILT_IN_MODELS[provider]?.[0] ?? BUILT_IN_MODELS.openai[0];
}

export function getBuiltInModelOptions(
  provider: KeygateConfig['llm']['provider'],
  currentModel?: string
): ProviderModelOption[] {
  const candidates = BUILT_IN_MODELS[provider] ?? [getDefaultModelForProvider(provider)];
  const defaultModel = getDefaultModelForProvider(provider);
  const uniqueModels = provider === 'openai-codex'
    ? Array.from(new Set(candidates))
    : Array.from(new Set([...(currentModel ? [currentModel] : []), ...candidates]));

  return uniqueModels.map((model, index) => ({
    id: model,
    provider,
    displayName: model,
    isDefault: model === defaultModel || (!uniqueModels.includes(defaultModel) && index === 0),
  }));
}
