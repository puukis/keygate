import type { KeygateConfig, LLMProvider } from '../types.js';
import { OpenAIProvider } from './OpenAIProvider.js';
import { GeminiProvider } from './GeminiProvider.js';

import { OllamaProvider } from './OllamaProvider.js';
import { OpenAICodexProvider } from './OpenAICodexProvider.js';

export { OpenAIProvider } from './OpenAIProvider.js';
export { GeminiProvider } from './GeminiProvider.js';
export { OllamaProvider } from './OllamaProvider.js';
export { OpenAICodexProvider, runCodexDeviceAuth } from './OpenAICodexProvider.js';

/**
 * Create an LLM provider based on config
 */
export function createLLMProvider(config: KeygateConfig): LLMProvider {
  const { provider, model, apiKey, reasoningEffort } = config.llm;

  switch (provider) {
    case 'openai':
      return new OpenAIProvider(apiKey, model);
    case 'gemini':
      return new GeminiProvider(apiKey, model);
    case 'ollama':
      return new OllamaProvider(model, config.llm.ollama?.host);
    case 'openai-codex':
      return new OpenAICodexProvider(model, {
        cwd: config.security.workspacePath,
        reasoningEffort,
      });
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}
