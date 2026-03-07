import type { KeygateConfig, LLMPricingOverride, LLMProviderName } from '../types.js';

interface CatalogEntry extends LLMPricingOverride {
  key: string;
}

const PRICING_CATALOG: Record<LLMProviderName, CatalogEntry[]> = {
  openai: [
    { key: 'gpt-4.1', inputPerMillionUsd: 2, outputPerMillionUsd: 8, cachedInputPerMillionUsd: 0.5 },
    { key: 'gpt-4o', inputPerMillionUsd: 2.5, outputPerMillionUsd: 10, cachedInputPerMillionUsd: 1.25 },
    { key: 'o3-mini', inputPerMillionUsd: 1.1, outputPerMillionUsd: 4.4, cachedInputPerMillionUsd: 0.55 },
  ],
  gemini: [
    { key: 'gemini-1.5-pro', inputPerMillionUsd: 3.5, outputPerMillionUsd: 10.5, cachedInputPerMillionUsd: 0.875 },
    { key: 'gemini-1.5-flash', inputPerMillionUsd: 0.35, outputPerMillionUsd: 1.05, cachedInputPerMillionUsd: 0.0875 },
  ],
  ollama: [],
  'openai-codex': [
    { key: 'openai-codex/gpt-5.3', inputPerMillionUsd: 1.25, outputPerMillionUsd: 10, cachedInputPerMillionUsd: 0.125 },
    { key: 'openai-codex/gpt-5.2', inputPerMillionUsd: 1, outputPerMillionUsd: 8, cachedInputPerMillionUsd: 0.1 },
  ],
};

export function resolvePricingOverride(
  config: KeygateConfig,
  provider: LLMProviderName | string,
  model: string
): LLMPricingOverride | undefined {
  const exactKey = `${provider}:${model}`;
  const configured = config.llm.pricing?.overrides ?? {};

  if (configured[exactKey]) {
    return configured[exactKey];
  }

  if (configured[model]) {
    return configured[model];
  }

  const catalog = PRICING_CATALOG[provider as LLMProviderName] ?? [];
  const exact = catalog.find((entry) => entry.key === model);
  if (exact) {
    return exact;
  }

  return catalog.find((entry) => model.startsWith(entry.key));
}

export function estimateCostUsd(
  pricing: LLMPricingOverride | undefined,
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number
): number | undefined {
  if (!pricing) {
    return undefined;
  }

  const uncachedInput = Math.max(0, inputTokens - cachedTokens);
  const cachedInput = Math.max(0, cachedTokens);
  const inputCost = (uncachedInput / 1_000_000) * pricing.inputPerMillionUsd;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillionUsd;
  const cachedCost = (cachedInput / 1_000_000) * (pricing.cachedInputPerMillionUsd ?? pricing.inputPerMillionUsd);

  return roundUsd(inputCost + outputCost + cachedCost);
}

export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
