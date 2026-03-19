import { createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderModelOption } from '../../types.js';
import { getBuiltInModelOptions, getDefaultModelForProvider } from '../../llm/modelCatalog.js';
import { collectProviderSettings, createDefaultState, CUSTOM_MODEL_VALUE, probeListenAddress } from '../commands/onboarding.js';
import type { ParsedArgs } from '../argv.js';

type CollectProviderSettingsDeps = NonNullable<Parameters<typeof collectProviderSettings>[2]>;

function makeArgs(flags: ParsedArgs['flags'] = {}): ParsedArgs {
  return {
    positional: ['onboarding'],
    flags,
  };
}

function createDeps(options: {
  selectResponses?: unknown[];
  textResponses?: string[];
  secretResponses?: string[];
  codexModels?: ProviderModelOption[];
  codexError?: Error;
} = {}) {
  const selectResponses = [...(options.selectResponses ?? [])];
  const textResponses = [...(options.textResponses ?? [])];
  const secretResponses = [...(options.secretResponses ?? [])];
  const dispose = vi.fn(async () => undefined);
  const session = {
    initialModel: getDefaultModelForProvider('openai-codex'),
    provider: {},
    dispose,
  };

  const deps = {
    selectMenu: vi.fn(async () => {
      if (selectResponses.length === 0) {
        throw new Error('Unexpected selectMenu call');
      }
      return selectResponses.shift();
    }),
    promptText: vi.fn(async (_prompt: string, defaultValue: string) => {
      if (textResponses.length === 0) {
        return defaultValue;
      }
      return textResponses.shift() as string;
    }),
    promptSecret: vi.fn(async () => {
      if (secretResponses.length === 0) {
        return '';
      }
      return secretResponses.shift() as string;
    }),
    getBuiltInModelOptions,
    getDefaultModelForProvider,
    openCodexLoginSession: vi.fn(async () => session),
    listCodexSessionModels: vi.fn(async () => {
      if (options.codexError) {
        throw options.codexError;
      }
      return options.codexModels ?? [];
    }),
    emitRailSpacer: vi.fn(),
    logInfo: vi.fn(),
    logOk: vi.fn(),
    logWarn: vi.fn(),
    printNote: vi.fn(),
  } satisfies CollectProviderSettingsDeps;

  return { deps, session };
}

describe('collectProviderSettings', () => {
  it.each([
    {
      provider: 'openai',
      modelTitle: 'OpenAI model',
      modelChoice: 'gpt-4.1',
      secretValue: 'sk-openai',
    },
    {
      provider: 'gemini',
      modelTitle: 'Gemini model',
      modelChoice: 'gemini-1.5-flash',
      secretValue: 'sk-gemini',
    },
    {
      provider: 'ollama',
      modelTitle: 'Ollama model',
      modelChoice: 'qwen2.5-coder',
      textResponses: ['http://127.0.0.1:11434'],
    },
  ])('uses an interactive model menu for $provider', async ({ provider, modelTitle, modelChoice, secretValue, textResponses }) => {
    const state = createDefaultState();
    const { deps } = createDeps({
      selectResponses: [provider, modelChoice],
      secretResponses: secretValue ? [secretValue] : [],
      textResponses: textResponses ?? [],
    });

    await collectProviderSettings(state, makeArgs(), deps);

    expect(state.provider).toBe(provider);
    expect(state.model).toBe(modelChoice);
    expect(deps.selectMenu).toHaveBeenCalledWith(
      modelTitle,
      expect.arrayContaining([expect.objectContaining({ value: modelChoice })]),
      expect.any(Number)
    );
    const promptedTitles = deps.promptText.mock.calls.map((call) => call[0]);
    expect(promptedTitles).not.toContain(modelTitle);
  });

  it('falls back to manual entry when Custom model ID is selected', async () => {
    const state = createDefaultState();
    const { deps } = createDeps({
      selectResponses: ['gemini', CUSTOM_MODEL_VALUE],
      textResponses: ['gemini-2.0-pro-exp'],
      secretResponses: ['sk-gemini'],
    });

    await collectProviderSettings(state, makeArgs(), deps);

    expect(state.provider).toBe('gemini');
    expect(state.model).toBe('gemini-2.0-pro-exp');
    expect(deps.promptText).toHaveBeenCalledWith('Gemini model', 'gemini-1.5-pro');
  });

  it('uses live Codex models when discovery succeeds', async () => {
    const state = createDefaultState();
    const liveModels: ProviderModelOption[] = [
      { id: 'openai-codex/gpt-5.3', provider: 'openai-codex', displayName: 'GPT-5.3', isDefault: true },
      { id: 'openai-codex/gpt-5.2', provider: 'openai-codex', displayName: 'GPT-5.2' },
    ];
    const { deps, session } = createDeps({
      selectResponses: ['openai-codex', 'openai-codex/gpt-5.2'],
      codexModels: liveModels,
    });

    await collectProviderSettings(state, makeArgs(), deps);

    expect(state.provider).toBe('openai-codex');
    expect(state.model).toBe('openai-codex/gpt-5.2');
    expect(deps.listCodexSessionModels).toHaveBeenCalledWith(session);
    expect(deps.printNote).not.toHaveBeenCalled();
    expect(deps.logOk).toHaveBeenCalledWith('Codex login completed.');
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it('falls back to the built-in Codex catalog when discovery returns no models', async () => {
    const state = createDefaultState();
    const { deps, session } = createDeps({
      selectResponses: ['openai-codex', 'openai-codex/gpt-5.2'],
      codexModels: [],
    });

    await collectProviderSettings(state, makeArgs(), deps);

    expect(state.model).toBe('openai-codex/gpt-5.2');
    expect(deps.printNote).toHaveBeenCalledWith(
      'Codex Models Unavailable',
      expect.stringContaining('Using the built-in Codex model list instead.'),
      expect.any(String)
    );
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it('falls back to the built-in Codex catalog when discovery throws', async () => {
    const state = createDefaultState();
    const { deps } = createDeps({
      selectResponses: ['openai-codex', 'openai-codex/gpt-5.2'],
      codexError: new Error('rpc unavailable'),
    });

    await collectProviderSettings(state, makeArgs(), deps);

    expect(state.model).toBe('openai-codex/gpt-5.2');
    expect(deps.printNote).toHaveBeenCalledWith(
      'Codex Models Unavailable',
      expect.stringContaining('rpc unavailable'),
      expect.any(String)
    );
  });
});

describe('probeListenAddress', () => {
  it('reports a free address as available', async () => {
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Expected numeric listen address'));
          return;
        }

        resolve(address.port);
      });
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));

    await expect(probeListenAddress('127.0.0.1', port)).resolves.toEqual({ available: true });
  });

  it('reports an occupied address as unavailable', async () => {
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Expected numeric listen address'));
          return;
        }

        resolve(address.port);
      });
    });

    try {
      await expect(probeListenAddress('127.0.0.1', port)).resolves.toEqual({
        available: false,
        code: 'EADDRINUSE',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
