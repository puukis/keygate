import type { EmbeddingProvider, MemoryConfig, MemoryProviderName } from './types.js';
import type { KeygateConfig } from '../../types.js';

/**
 * Create an embedding provider based on configuration.
 *
 * When provider is 'auto', probes configured LLM providers in order:
 * openai → codex → gemini → ollama, and uses the first one with valid credentials.
 */
export async function createEmbeddingProvider(
  config: KeygateConfig,
  memoryConfig: MemoryConfig,
): Promise<EmbeddingProvider> {
  const provider = memoryConfig.provider;

  if (provider === 'auto') {
    return autoSelectProvider(config, memoryConfig.model);
  }

  return createSpecificProvider(provider, config, memoryConfig.model);
}

async function autoSelectProvider(
  config: KeygateConfig,
  modelOverride?: string,
): Promise<EmbeddingProvider> {
  const order: Exclude<MemoryProviderName, 'auto'>[] = ['openai', 'codex', 'gemini', 'ollama'];

  for (const name of order) {
    try {
      return await createSpecificProvider(name, config, modelOverride);
    } catch {
      // provider not available, try next
    }
  }

  throw new Error(
    'No embedding provider available. Set KEYGATE_MEMORY_PROVIDER or configure an LLM provider with valid credentials.',
  );
}

async function createSpecificProvider(
  name: Exclude<MemoryProviderName, 'auto'>,
  config: KeygateConfig,
  modelOverride?: string,
): Promise<EmbeddingProvider> {
  switch (name) {
    case 'openai': {
      const apiKey = config.llm.apiKey || process.env['OPENAI_API_KEY'];
      if (!apiKey) throw new Error('OpenAI API key not configured');
      const { OpenAIEmbeddingProvider } = await import('./openai.js');
      return new OpenAIEmbeddingProvider(apiKey, modelOverride);
    }

    case 'codex': {
      const { getValidAccessToken } = await import('../../auth/index.js');
      try {
        const tokenEndpoint = process.env['OPENAI_OAUTH_TOKEN_ENDPOINT'] ?? 'https://auth.openai.com/oauth/token';
        const clientId = process.env['OPENAI_OAUTH_CLIENT_ID'] ?? '';
        const accessToken = await getValidAccessToken(tokenEndpoint, clientId);
        const { CodexEmbeddingProvider } = await import('./codex.js');
        return new CodexEmbeddingProvider(accessToken, modelOverride);
      } catch {
        throw new Error('Codex OAuth token not available. Run `keygate auth login --provider openai-codex` first.');
      }
    }

    case 'gemini': {
      const apiKey = config.llm.apiKey || process.env['GEMINI_API_KEY'];
      if (!apiKey && config.llm.provider !== 'gemini') {
        throw new Error('Gemini API key not configured');
      }
      if (!apiKey) throw new Error('Gemini API key not configured');
      const { GeminiEmbeddingProvider } = await import('./gemini.js');
      return new GeminiEmbeddingProvider(apiKey, modelOverride);
    }

    case 'ollama': {
      const host = config.llm.ollama?.host ?? 'http://127.0.0.1:11434';
      const { OllamaEmbeddingProvider } = await import('./ollama.js');
      return new OllamaEmbeddingProvider(modelOverride, host);
    }
  }
}
