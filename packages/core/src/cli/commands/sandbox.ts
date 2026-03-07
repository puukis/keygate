import { loadConfigFromEnv } from '../../config/env.js';
import { SandboxManager } from '../../sandbox/index.js';
import type { ParsedArgs } from '../argv.js';

export async function runSandboxCommand(args: ParsedArgs): Promise<void> {
  const subcommand = args.positional[1];
  const sandbox = new SandboxManager(loadConfigFromEnv());

  switch (subcommand) {
    case 'list': {
      const sandboxes = await sandbox.list();
      if (args.flags['json'] === true) {
        console.log(JSON.stringify(sandboxes, null, 2));
        return;
      }
      console.log(sandboxes.length > 0
        ? sandboxes.map((entry) => `- ${entry.containerName} (${entry.image})`).join('\n')
        : 'No active sandboxes.');
      return;
    }
    case 'explain': {
      const scopeKey = typeof args.flags['scope'] === 'string' ? args.flags['scope'] : (args.positional[2] ?? 'default');
      const detail = await sandbox.explain(scopeKey);
      console.log(JSON.stringify(detail, null, 2));
      return;
    }
    case 'recreate': {
      const scopeKey = typeof args.flags['scope'] === 'string' ? args.flags['scope'] : (args.positional[2] ?? 'default');
      const workspacePath = typeof args.flags['workspace'] === 'string'
        ? args.flags['workspace']
        : loadConfigFromEnv().security.workspacePath;
      const record = await sandbox.recreate(scopeKey, workspacePath);
      console.log(JSON.stringify(record, null, 2));
      return;
    }
    default:
      throw new Error('Usage: keygate sandbox <list|explain|recreate> [--scope <key>] [--workspace <path>] [--json]');
  }
}
