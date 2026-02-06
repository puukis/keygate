import { spawn, spawnSync } from 'node:child_process';

export type CodexInstallMethod = 'existing' | 'npm' | 'brew';

export interface EnsureCodexInstalledOptions {
  autoInstall?: boolean;
  preferBrewOnMac?: boolean;
}

export interface EnsureCodexInstalledResult {
  installed: boolean;
  method?: CodexInstallMethod;
  version?: string;
  attempts: string[];
  error?: string;
}

export function isCodexInstalled(): boolean {
  const version = getCodexVersion();
  return version !== null;
}

export function getCodexVersion(): string | null {
  const result = spawnSync('codex', ['--version'], {
    stdio: 'pipe',
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    return null;
  }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (!output) {
    return 'unknown';
  }

  return output.split(/\r?\n/g)[0] ?? 'unknown';
}

export async function ensureCodexInstalled(
  options: EnsureCodexInstalledOptions = {}
): Promise<EnsureCodexInstalledResult> {
  const attempts: string[] = [];

  const existingVersion = getCodexVersion();
  if (existingVersion) {
    return {
      installed: true,
      method: 'existing',
      version: existingVersion,
      attempts,
    };
  }

  if (!options.autoInstall) {
    return {
      installed: false,
      attempts,
      error: 'Codex CLI is not installed',
    };
  }

  const methods = getInstallMethods(options.preferBrewOnMac ?? false);

  for (const method of methods) {
    attempts.push(method.description);
    const ok = await runCommand(method.command, method.args);
    if (!ok) {
      continue;
    }

    const version = getCodexVersion();
    if (version) {
      return {
        installed: true,
        method: method.id,
        version,
        attempts,
      };
    }
  }

  return {
    installed: false,
    attempts,
    error: getCodexInstallHelp(),
  };
}

export function getCodexInstallHelp(): string {
  const lines = [
    'Install Codex CLI manually, then retry:',
    '1. npm i -g @openai/codex',
  ];

  if (process.platform === 'darwin') {
    lines.push('2. (optional macOS) brew install --cask codex');
  }

  lines.push('3. Verify with: codex --version');

  return lines.join('\n');
}

interface InstallMethod {
  id: CodexInstallMethod;
  description: string;
  command: string;
  args: string[];
}

function getInstallMethods(preferBrewOnMac: boolean): InstallMethod[] {
  const npmMethod: InstallMethod = {
    id: 'npm',
    description: 'npm i -g @openai/codex',
    command: 'npm',
    args: ['i', '-g', '@openai/codex'],
  };

  const brewMethod: InstallMethod = {
    id: 'brew',
    description: 'brew install --cask codex',
    command: 'brew',
    args: ['install', '--cask', 'codex'],
  };

  if (process.platform !== 'darwin') {
    return [npmMethod];
  }

  if (preferBrewOnMac) {
    return [brewMethod, npmMethod];
  }

  return [npmMethod, brewMethod];
}

async function runCommand(command: string, args: string[]): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
    });

    child.once('error', () => {
      resolve(false);
    });

    child.once('exit', (code) => {
      resolve(code === 0);
    });
  });
}
