import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParsedArgs } from '../argv.js';

const {
  ensureCodexInstalled,
  loadConfigFromEnv,
  updateKeygateFile,
  providerLogin,
  providerListModels,
  providerDispose,
  readTokens,
  isTokenExpired,
  deleteTokens,
} = vi.hoisted(() => ({
  ensureCodexInstalled: vi.fn(async () => ({ installed: true, attempts: [], version: '1.0.0' })),
  loadConfigFromEnv: vi.fn(() => ({
    llm: { provider: 'openai', model: 'gpt-4o' },
    security: { workspacePath: '/tmp/keygate' },
  })),
  updateKeygateFile: vi.fn(async () => undefined),
  providerLogin: vi.fn(async () => undefined),
  providerListModels: vi.fn(async () => [
    { id: 'openai-codex/gpt-5.2', provider: 'openai-codex', displayName: 'GPT-5.2', isDefault: true },
    { id: 'openai-codex/gpt-5.3', provider: 'openai-codex', displayName: 'GPT-5.3' },
  ]),
  providerDispose: vi.fn(async () => undefined),
  readTokens: vi.fn(async () => null),
  isTokenExpired: vi.fn(() => false),
  deleteTokens: vi.fn(async () => undefined),
}));

vi.mock('../codexInstall.js', () => ({
  ensureCodexInstalled,
  getCodexInstallHelp: () => 'install help',
}));

vi.mock('../../config/env.js', () => ({
  loadConfigFromEnv,
  updateKeygateFile,
}));

vi.mock('../../auth/index.js', () => ({
  readTokens,
  isTokenExpired,
  deleteTokens,
}));

vi.mock('../../llm/OpenAICodexProvider.js', () => ({
  OpenAICodexProvider: vi.fn().mockImplementation(() => ({
    login: providerLogin,
    listModels: providerListModels,
    dispose: providerDispose,
  })),
}));

import { runAuthCommand } from '../commands/auth.js';

function makeArgs(flags: ParsedArgs['flags'] = {}): ParsedArgs {
  return {
    positional: ['auth', 'login'],
    flags: {
      provider: 'openai-codex',
      ...flags,
    },
  };
}

describe('auth command', () => {
  afterEach(() => {
    ensureCodexInstalled.mockClear();
    loadConfigFromEnv.mockClear();
    updateKeygateFile.mockClear();
    providerLogin.mockClear();
    providerListModels.mockClear();
    providerDispose.mockClear();
    readTokens.mockClear();
    isTokenExpired.mockClear();
    deleteTokens.mockClear();
  });

  it('persists the default discovered Codex model after login', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await runAuthCommand(makeArgs());
    } finally {
      consoleSpy.mockRestore();
    }

    expect(providerLogin).toHaveBeenCalledTimes(1);
    expect(providerListModels).toHaveBeenCalledTimes(1);
    expect(updateKeygateFile).toHaveBeenCalledWith({
      LLM_PROVIDER: 'openai-codex',
      LLM_MODEL: 'openai-codex/gpt-5.2',
      LLM_API_KEY: '',
    });
    expect(providerDispose).toHaveBeenCalledTimes(1);
  });

  it('falls back to the initial Codex model when discovery fails', async () => {
    providerListModels.mockRejectedValueOnce(new Error('list failed'));
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await runAuthCommand(makeArgs());
    } finally {
      consoleSpy.mockRestore();
    }

    expect(updateKeygateFile).toHaveBeenCalledWith({
      LLM_PROVIDER: 'openai-codex',
      LLM_MODEL: 'openai-codex/gpt-5.3',
      LLM_API_KEY: '',
    });
  });
});
