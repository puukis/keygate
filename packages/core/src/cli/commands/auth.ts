import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { OpenAICodexProvider } from '../../llm/OpenAICodexProvider.js';
import { ensureCodexInstalled, getCodexInstallHelp } from '../codexInstall.js';
import { getFlagString, hasFlag, type ParsedArgs } from '../argv.js';
import { loadConfigFromEnv, updateKeygateFile } from '../../config/env.js';
import type { ProviderModelOption } from '../../types.js';
import { readTokens, isTokenExpired, deleteTokens } from '../../auth/index.js';
import readline from 'node:readline';

export async function runAuthCommand(args: ParsedArgs): Promise<void> {
  const action = args.positional[1];

  switch (action) {
    case 'login':
      return runAuthLogin(args);
    case 'logout':
      return runAuthLogout(args);
    case 'status':
      return runAuthStatus();
    default:
      throw new Error(`Unknown auth command: ${args.positional.slice(0, 2).join(' ')}. Use login, logout, or status.`);
  }
}

async function runAuthLogin(args: ParsedArgs): Promise<void> {
  const provider = getFlagString(args.flags, 'provider', 'openai-codex');
  if (provider !== 'openai-codex') {
    throw new Error('Only --provider openai-codex is currently supported for auth login');
  }

  const useDeviceAuth = hasFlag(args.flags, 'device-auth');

  const codexStatus = await ensureCodexInstalled({ autoInstall: false });
  if (!codexStatus.installed) {
    throw new Error(`${codexStatus.error ?? 'Codex CLI is not installed'}\n${getCodexInstallHelp()}`);
  }

  const config = loadConfigFromEnv();
  const initialModel =
    config.llm.provider === 'openai-codex'
      ? config.llm.model
      : 'openai-codex/gpt-5.3';

  const headless = hasFlag(args.flags, 'headless');

  const codexProvider = new OpenAICodexProvider(initialModel, {
    cwd: config.security.workspacePath,
    readCallbackUrl: headless ? readLineFromStdin : undefined,
  });

  try {
    if (useDeviceAuth) {
      await runCodexDeviceAuthLogin();
    } else {
      await codexProvider.login({ headless });
    }

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

    console.log('OpenAI OAuth login complete.');
    console.log(`Selected model: ${selectedModel}`);
  } finally {
    await codexProvider.dispose();
  }
}

async function runCodexDeviceAuthLogin(): Promise<void> {
  const codexBin = process.env['KEYGATE_CODEX_BIN']?.trim() || 'codex';
  const args = ['login', '--device-auth'];

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(codexBin, args, {
      stdio: 'inherit',
    });

    child.once('error', (error) => {
      reject(error);
    });

    child.once('exit', (code) => {
      resolve(code);
    });
  });

  if (exitCode !== 0) {
    throw new Error(`Codex device auth login failed with exit code ${String(exitCode)}.`);
  }
}

async function runAuthLogout(args: ParsedArgs): Promise<void> {
  const force = hasFlag(args.flags, 'force');

  // Always remove local keygate tokens.
  await deleteTokens();

  if (force) {
    // Remove Codex CLI's auth.json to force a full re-login.
    const codexAuthPath = path.join(os.homedir(), '.codex', 'auth.json');
    try {
      await fs.rm(codexAuthPath, { force: true });
      console.log('Logged out. All auth data removed (keygate tokens + Codex CLI session).');
      console.log('You will need to sign in again on next login.');
    } catch {
      console.log('Logged out. Keygate tokens removed. Could not remove Codex CLI auth data.');
    }
  } else {
    console.log('Logged out. Keygate OAuth tokens removed.');
    console.log('Hint: Use --force to also remove the Codex CLI session and require a full re-login.');
  }
}

async function runAuthStatus(): Promise<void> {
  // Check local tokens first (custom PKCE flow).
  const tokens = await readTokens();

  if (tokens) {
    const expired = isTokenExpired(tokens);
    const expiresAt = new Date(tokens.expires_at * 1000).toISOString();

    console.log(`Status: Logged in (local OAuth tokens)`);
    if (tokens.account_id) {
      console.log(`Account: ${tokens.account_id}`);
    }
    console.log(`Token expires: ${expiresAt}${expired ? ' (EXPIRED)' : ''}`);
    console.log(`Refresh token: ${tokens.refresh_token ? 'present' : 'none'}`);
    return;
  }

  // Fall back to checking via Codex CLI's built-in auth.
  const codexStatus = await ensureCodexInstalled({ autoInstall: false });
  if (codexStatus.installed) {
    const config = loadConfigFromEnv();
    const initialModel =
      config.llm.provider === 'openai-codex'
        ? config.llm.model
        : 'openai-codex/gpt-5.3';

    const codexProvider = new OpenAICodexProvider(initialModel, {
      cwd: config.security.workspacePath,
    });

    try {
      const account = await codexProvider.checkAccount();
      if (account.account) {
        console.log(`Status: Logged in (Codex CLI)`);
        if (account.account.email) {
          console.log(`Account: ${account.account.email}`);
        }
        return;
      }
    } catch {
      // Codex RPC unavailable — fall through.
    } finally {
      await codexProvider.dispose();
    }
  }

  console.log('Status: Not logged in.');
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
        reject(new Error('No URL provided.'));
        return;
      }
      resolve(trimmed);
    });
  });
}
