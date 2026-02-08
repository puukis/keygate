import { OpenAICodexProvider } from '../../llm/OpenAICodexProvider.js';
import { ensureCodexInstalled, getCodexInstallHelp } from '../codexInstall.js';
import { getFlagString, hasFlag, type ParsedArgs } from '../argv.js';
import { loadConfigFromEnv, updateKeygateFile } from '../../config/env.js';
import type { ProviderModelOption } from '../../types.js';

export async function runAuthCommand(args: ParsedArgs): Promise<void> {
  const action = args.positional[1];

  if (action !== 'login') {
    throw new Error(`Unknown auth command: ${args.positional.slice(0, 2).join(' ')}`);
  }

  const provider = getFlagString(args.flags, 'provider', 'openai-codex');
  if (provider !== 'openai-codex') {
    throw new Error('Only --provider openai-codex is currently supported for auth login');
  }

  const codexStatus = await ensureCodexInstalled({ autoInstall: false });
  if (!codexStatus.installed) {
    throw new Error(`${codexStatus.error ?? 'Codex CLI is not installed'}\n${getCodexInstallHelp()}`);
  }

  const config = loadConfigFromEnv();
  const initialModel =
    config.llm.provider === 'openai-codex'
      ? config.llm.model
      : 'openai-codex/gpt-5.3';

  const codexProvider = new OpenAICodexProvider(initialModel, {
    cwd: config.security.workspacePath,
  });

  try {
    const forceDeviceAuth = hasFlag(args.flags, 'device-auth');
    const noDeviceFallback = hasFlag(args.flags, 'no-device-fallback');

    await codexProvider.login({
      useDeviceAuth: forceDeviceAuth,
      allowDeviceAuthFallback: !noDeviceFallback,
    });

    let selectedModel = initialModel;

    try {
      const models = await codexProvider.listModels();
      selectedModel = pickDefaultProviderModel(models, initialModel);
    } catch {
      // Keep configured model if model/list is unavailable in this environment.
    }

    await updateKeygateFile({
      LLM_PROVIDER: 'openai-codex',
      LLM_MODEL: selectedModel,
      LLM_API_KEY: '',
    });

    console.log('OpenAI Codex login complete.');
    console.log(`Selected model: ${selectedModel}`);
  } finally {
    await codexProvider.dispose();
  }
}

function pickDefaultProviderModel(models: ProviderModelOption[], fallback: string): string {
  if (models.length === 0) {
    return fallback;
  }

  const explicitDefault = models.find((model) => model.isDefault);
  if (explicitDefault) {
    return explicitDefault.id;
  }

  const preferred = models.find((model) => model.id === 'openai-codex/gpt-5.3');
  if (preferred) {
    return preferred.id;
  }

  return models[0]!.id;
}
