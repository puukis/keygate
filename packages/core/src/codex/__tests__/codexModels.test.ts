import { describe, expect, it } from 'vitest';
import { codexModelFromProviderModelId, normalizeCodexModels } from '../codexModels.js';

describe('codexModels', () => {
  it('keeps only GPT-5.3/5.2 Codex models and exposes fixed reasoning efforts', () => {
    const models = normalizeCodexModels([
      { id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', isDefault: true },
      { id: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', isDefault: false },
      { id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: false },
    ]);

    expect(models.map((model) => model.id)).toEqual([
      'gpt-5.3-codex',
      'gpt-5.2-codex',
    ]);
    expect(models.filter((model) => model.isDefault).map((model) => model.id)).toEqual(['gpt-5.2-codex']);
    expect(models[0]?.reasoningEffort).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(models[1]?.reasoningEffort).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('falls back to the default model when an unsupported codex model is requested', () => {
    const models = normalizeCodexModels([]);
    const resolved = codexModelFromProviderModelId('openai-codex/gpt-5', models);

    expect(resolved).toBe('gpt-5.3-codex');
  });
});
