import { parseArgs } from './argv.js';
import { runOnboardCommand } from './commands/onboard.js';
import { runAuthCommand } from './commands/auth.js';
import { runInstallCommand } from './commands/install.js';
import { runUninstallCommand } from './commands/uninstall.js';
import { runUpdateCommand } from './commands/update.js';

export async function runCli(argv: string[]): Promise<boolean> {
  if (argv.length === 0) {
    return false;
  }

  const args = parseArgs(argv);
  const command = args.positional[0];

  if (args.flags['help'] || args.flags['h']) {
    printHelp();
    return true;
  }

  if (!command || command === 'serve') {
    return false;
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return true;
  }

  switch (command) {
    case 'onboard':
      await runOnboardCommand(args);
      return true;
    case 'auth':
      await runAuthCommand(args);
      return true;
    case 'install':
      await runInstallCommand(args);
      return true;
    case 'uninstall':
      await runUninstallCommand(args);
      return true;
    case 'update':
      await runUpdateCommand(args);
      return true;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

export function printHelp(): void {
  console.log(`Keygate CLI

Usage:
  keygate serve
  keygate onboard --auth-choice openai-codex [--device-auth]
  keygate auth login --provider openai-codex [--device-auth]
  keygate install codex [--method npm|brew]
  keygate uninstall [--yes] [--remove-config] [--remove-workspace]
  keygate update [--check-only]

Notes:
  - openai-codex uses ChatGPT OAuth through Codex app-server.
  - No OpenAI API key is required for openai-codex.
`);
}
