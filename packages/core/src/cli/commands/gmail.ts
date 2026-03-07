import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { loadConfigFromEnv } from '../../config/env.js';
import { GmailAutomationService } from '../../gmail/index.js';
import { getFlagString, hasFlag, type ParsedArgs } from '../argv.js';

export async function runGmailCommand(args: ParsedArgs): Promise<void> {
  const action = args.positional[1];
  const config = loadConfigFromEnv();
  const gmail = new GmailAutomationService(config);

  switch (action) {
    case 'login': {
      const headless = hasFlag(args.flags, 'headless');
      const account = await gmail.login({
        openExternalUrl: headless ? undefined : openExternalUrl,
        readCallbackUrl: headless ? readLineFromStdin : undefined,
      });
      console.log(`Logged into Gmail account: ${account.email}`);
      return;
    }

    case 'list': {
      const payload = await gmail.list();
      if (args.flags['json'] === true) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log('Accounts:');
      if (payload.accounts.length === 0) {
        console.log('- none');
      } else {
        for (const account of payload.accounts) {
          console.log(`- ${account.id}: ${account.email}`);
        }
      }

      console.log('\nWatches:');
      if (payload.watches.length === 0) {
        console.log('- none');
      } else {
        for (const watch of payload.watches) {
          console.log(`- ${watch.id}: account=${watch.accountId} session=${watch.targetSessionId} enabled=${watch.enabled} labels=${watch.labelIds.join(',') || '(all)'}`);
        }
      }
      return;
    }

    case 'watch': {
      const accountId = await resolveAccountId(gmail, getFlagString(args.flags, 'account', ''));
      const sessionId = getFlagString(args.flags, 'session', '');
      if (!sessionId.trim()) {
        throw new Error('Usage: keygate gmail watch --session <id> [--account <id|email>] [--labels a,b] [--prompt-prefix text]');
      }

      const watch = await gmail.createWatch({
        accountId,
        targetSessionId: sessionId.trim(),
        labelIds: parseListFlag(args.flags['labels']),
        promptPrefix: getOptionalFlagString(args.flags['prompt-prefix']),
        enabled: !hasFlag(args.flags, 'disabled'),
      });
      console.log(JSON.stringify(watch, null, 2));
      return;
    }

    case 'update': {
      const watchId = args.positional[2]?.trim() ?? '';
      if (!watchId) {
        throw new Error('Usage: keygate gmail update <watchId> [--session <id>] [--labels a,b] [--prompt-prefix text] [--enabled true|false]');
      }

      const watch = await gmail.updateWatch(watchId, {
        targetSessionId: getOptionalFlagString(args.flags['session']),
        labelIds: args.flags['labels'] === undefined ? undefined : parseListFlag(args.flags['labels']),
        promptPrefix: getOptionalFlagString(args.flags['prompt-prefix']),
        enabled: parseOptionalBoolean(args.flags['enabled']),
      });
      console.log(JSON.stringify(watch, null, 2));
      return;
    }

    case 'delete': {
      const watchId = args.positional[2]?.trim() ?? '';
      if (!watchId) {
        throw new Error('Usage: keygate gmail delete <watchId>');
      }
      const deleted = await gmail.deleteWatch(watchId);
      console.log(JSON.stringify({ watchId, deleted }, null, 2));
      return;
    }

    case 'test': {
      const watchId = args.positional[2]?.trim() ?? '';
      if (!watchId) {
        throw new Error('Usage: keygate gmail test <watchId>');
      }
      const result = await gmail.testWatch(watchId);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    case 'renew': {
      const account = getOptionalFlagString(args.flags['account']);
      if (account) {
        const accountId = await resolveAccountId(gmail, account);
        const result = await gmail.renewAccountWatches(accountId);
        console.log(JSON.stringify({ accountId, ...result }, null, 2));
        return;
      }

      const count = await gmail.renewDueWatches();
      console.log(JSON.stringify({ renewedAccounts: count }, null, 2));
      return;
    }

    default:
      throw new Error('Usage: keygate gmail <login|list|watch|update|delete|test|renew> ...');
  }
}

async function resolveAccountId(gmail: GmailAutomationService, requested: string): Promise<string> {
  const payload = await gmail.list();
  if (payload.accounts.length === 0) {
    throw new Error('No Gmail account is configured yet. Run `keygate gmail login` first.');
  }

  const normalized = requested.trim().toLowerCase();
  if (!normalized) {
    return payload.accounts[0]!.id;
  }

  const match = payload.accounts.find((account) => (
    account.id.toLowerCase() === normalized || account.email.toLowerCase() === normalized
  ));
  if (!match) {
    throw new Error(`Unknown Gmail account: ${requested}`);
  }
  return match.id;
}

function parseListFlag(value: string | boolean | undefined): string[] {
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function getOptionalFlagString(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseOptionalBoolean(value: string | boolean | undefined): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return undefined;
}

function readLineFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question('> ', (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (!trimmed) {
        reject(new Error('No callback URL provided.'));
        return;
      }
      resolve(trimmed);
    });
  });
}

async function openExternalUrl(url: string): Promise<boolean> {
  const platform = process.platform;
  const command =
    platform === 'darwin'
      ? { cmd: 'open', args: [url] }
      : platform === 'win32'
        ? { cmd: 'cmd', args: ['/c', 'start', '', url] }
        : { cmd: 'xdg-open', args: [url] };

  return new Promise<boolean>((resolve) => {
    const child = spawn(command.cmd, command.args, {
      stdio: 'ignore',
      detached: platform !== 'win32',
    });

    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}
