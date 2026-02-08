import { ensureCodexInstalled, getCodexInstallHelp } from '../codexInstall.js';
import { getFlagString, hasFlag, type ParsedArgs } from '../argv.js';
import { runAuthCommand } from './auth.js';
import { updateKeygateFile } from '../../config/env.js';

export async function runOnboardCommand(args: ParsedArgs): Promise<void> {
  const authChoice = getFlagString(args.flags, 'auth-choice', 'openai-codex');

  if (authChoice !== 'openai-codex') {
    throw new Error(`Unsupported --auth-choice: ${authChoice}. Supported: openai-codex`);
  }

  const installMethod = getFlagString(args.flags, 'install-method', 'auto');
  const preferBrewOnMac = installMethod === 'brew';

  console.log('Checking Codex installation...');
  const installResult = await ensureCodexInstalled({
    autoInstall: true,
    preferBrewOnMac,
  });

  if (!installResult.installed) {
    const attempts = installResult.attempts.length > 0
      ? `Attempted:\n- ${installResult.attempts.join('\n- ')}`
      : 'No installation methods were attempted.';

    throw new Error(`${attempts}\n\n${installResult.error ?? getCodexInstallHelp()}`);
  }

  console.log(`Codex ready (${installResult.version ?? 'unknown version'})`);

  if (hasFlag(args.flags, 'skip-login')) {
    await updateKeygateFile({
      LLM_PROVIDER: 'openai-codex',
      LLM_MODEL: 'openai-codex/gpt-5.3',
      LLM_API_KEY: '',
    });

    console.log('Onboarding complete (login skipped).');
    return;
  }

  await runAuthCommand({
    positional: ['auth', 'login'],
    flags: {
      provider: 'openai-codex',
      ...(hasFlag(args.flags, 'device-auth') ? { 'device-auth': true } : {}),
      ...(hasFlag(args.flags, 'no-device-fallback') ? { 'no-device-fallback': true } : {}),
    },
  });

  console.log('Onboarding complete.');
}
