import type { KeygateConfig, LLMProvider } from '../types.js';
import { OpenAIProvider } from './OpenAIProvider.js';
import { GeminiProvider } from './GeminiProvider.js';

import { OllamaProvider } from './OllamaProvider.js';

export { OpenAIProvider } from './OpenAIProvider.js';
export { GeminiProvider } from './GeminiProvider.js';
export { OllamaProvider } from './OllamaProvider.js';

/**
 * Create an LLM provider based on config
 */
export function createLLMProvider(config: KeygateConfig): LLMProvider {
  const { provider, model, apiKey } = config.llm;

  switch (provider) {
    case 'openai':
      return new OpenAIProvider(apiKey, model);
    case 'gemini':
      return new GeminiProvider(apiKey, model);
    case 'ollama':
      return new OllamaProvider(model, config.llm.ollama?.host);
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}
