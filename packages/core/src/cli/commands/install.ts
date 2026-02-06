import { ensureCodexInstalled, getCodexInstallHelp } from '../codexInstall.js';
import { getFlagString, type ParsedArgs } from '../argv.js';

export async function runInstallCommand(args: ParsedArgs): Promise<void> {
  const target = args.positional[1] ?? 'codex';

  if (target !== 'codex') {
    throw new Error(`Unknown install target: ${target}`);
  }

  const installMethod = getFlagString(args.flags, 'method', 'auto');

  const result = await ensureCodexInstalled({
    autoInstall: true,
    preferBrewOnMac: installMethod === 'brew',
  });

  if (!result.installed) {
    const attempts = result.attempts.length > 0
      ? `Attempted:\n- ${result.attempts.join('\n- ')}`
      : 'No installation commands were attempted.';

    throw new Error(`${attempts}\n\n${result.error ?? getCodexInstallHelp()}`);
  }

  console.log(`Codex installed (${result.version ?? 'unknown version'}).`);
}
