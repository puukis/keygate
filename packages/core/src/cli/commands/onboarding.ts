import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { getFlagString, hasFlag, type ParsedArgs } from '../argv.js';
import { getConfigDir, getDefaultWorkspacePath, updateEnvFile } from '../../config/env.js';
import { runAuthCommand } from './auth.js';

type ProviderChoice = 'openai' | 'openai-codex' | 'gemini' | 'ollama';

interface OnboardingState {
  provider: ProviderChoice;
  model: string;
  apiKey: string;
  ollamaHost: string;
  spicyModeEnabled: boolean;
  spicyMaxObedienceEnabled: boolean;
  workspacePath: string;
  port: number;
}

interface MenuOption<T> {
  label: string;
  description: string;
  value: T;
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const ACCENT = '\x1b[38;2;255;90;45m';
const ACCENT_DIM = '\x1b[38;2;209;74;34m';
const INFO = '\x1b[38;2;255;138;91m';
const SUCCESS = '\x1b[38;2;47;191;113m';
const WARN = '\x1b[38;2;255;176;32m';
const MUTED = '\x1b[38;2;139;127;119m';

const DEFAULT_CHAT_URL = 'http://localhost:18790';
const DEFAULT_ALLOWED_BINARIES = ['git', 'ls', 'npm', 'cat', 'node', 'python3'];

export async function runOnboardingCommand(args: ParsedArgs): Promise<void> {
  const promptable = isPromptable();
  const noPrompt = hasFlag(args.flags, 'no-prompt') || !promptable;
  const defaultsOnly = hasFlag(args.flags, 'defaults') || noPrompt;
  const noRun = hasFlag(args.flags, 'no-run');

  const state = createDefaultState();
  const workspaceFlag = getFlagString(args.flags, 'workspace-path', '').trim();
  if (workspaceFlag.length > 0) {
    state.workspacePath = expandHomePath(workspaceFlag);
  }

  printHeader();

  if (defaultsOnly) {
    if (!promptable) {
      logWarn('No interactive TTY detected. Applying deterministic defaults.');
    } else {
      logInfo('Applying deterministic defaults.');
    }

    await persistOnboardingState(state);
    await finishOnboarding(state, {
      noPrompt,
      noRun,
    });
    return;
  }

  const continueSetup = await selectMenu(
    'Continue setup?',
    [
      {
        label: 'Continue setup',
        description: 'Configure provider, auth, and security mode now.',
        value: true,
      },
      {
        label: 'Exit',
        description: 'Leave existing configuration unchanged.',
        value: false,
      },
    ],
    0
  );

  if (!continueSetup) {
    logWarn('Onboarding cancelled.');
    return;
  }

  const spicyMode = await selectMenu(
    'Choose security mode',
    [
      {
        label: 'Safe Mode (Recommended)',
        description: 'Sandboxed workspace with safer defaults.',
        value: false,
      },
      {
        label: 'Spicy Mode',
        description: 'Full host access. High-risk, unrestricted execution.',
        value: true,
      },
    ],
    0
  );

  if (spicyMode) {
    const ack = await promptText(
      'Type I ACCEPT THE RISK to enable Spicy Mode (or press Enter to keep Safe Mode)',
      ''
    );
    if (ack === 'I ACCEPT THE RISK') {
      state.spicyModeEnabled = true;
      logWarn('Spicy Mode enabled.');
    } else {
      state.spicyModeEnabled = false;
      logOk('Safe Mode kept.');
    }
  } else {
    state.spicyModeEnabled = false;
    logOk('Safe Mode enabled.');
  }

  await collectProviderSettings(state, args);
  await persistOnboardingState(state);
  await finishOnboarding(state, {
    noPrompt: false,
    noRun,
  });
}

function printHeader(): void {
  console.log('');
  for (const line of renderStaticPanel('Keygate Onboarding', 'Configure provider, auth, and startup behavior.')) {
    console.log(line);
  }
  console.log('');
}

function createDefaultState(): OnboardingState {
  return {
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: '',
    ollamaHost: '',
    spicyModeEnabled: false,
    spicyMaxObedienceEnabled: false,
    workspacePath: getDefaultWorkspacePath(),
    port: 18790,
  };
}

async function collectProviderSettings(state: OnboardingState, args: ParsedArgs): Promise<void> {
  while (true) {
    const provider = await selectMenu(
      'Choose provider',
      [
        {
          label: 'OpenAI',
          description: 'Use OpenAI API key and model selection.',
          value: 'openai' as const,
        },
        {
          label: 'OpenAI Codex (ChatGPT OAuth)',
          description: 'Runs keygate auth login immediately.',
          value: 'openai-codex' as const,
        },
        {
          label: 'Google Gemini',
          description: 'Use Gemini API key and model selection.',
          value: 'gemini' as const,
        },
        {
          label: 'Ollama',
          description: 'Use local Ollama endpoint and local model.',
          value: 'ollama' as const,
        },
        {
          label: 'Skip for now',
          description: 'Use safe default provider config.',
          value: 'skip' as const,
        },
      ],
      1
    );

    if (provider === 'skip') {
      state.provider = 'openai';
      state.model = 'gpt-4o';
      state.apiKey = '';
      state.ollamaHost = '';
      return;
    }

    if (provider === 'openai') {
      state.provider = 'openai';
      state.model = await promptText('OpenAI model', 'gpt-4o');
      state.apiKey = await promptSecret('OpenAI API key');
      state.ollamaHost = '';
      return;
    }

    if (provider === 'gemini') {
      state.provider = 'gemini';
      state.model = await promptText('Gemini model', 'gemini-1.5-pro');
      state.apiKey = await promptSecret('Gemini API key');
      state.ollamaHost = '';
      return;
    }

    if (provider === 'ollama') {
      state.provider = 'ollama';
      state.model = await promptText('Ollama model', 'llama3');
      state.ollamaHost = await promptText('Ollama host', 'http://127.0.0.1:11434');
      state.apiKey = '';
      return;
    }

    state.provider = 'openai-codex';
    state.model = await promptText('Codex model', 'openai-codex/gpt-5.3');
    state.apiKey = '';
    state.ollamaHost = '';

    const loggedIn = await runCodexLogin(args);
    if (loggedIn) {
      return;
    }

    logInfo('Returning to provider selection...');
  }
}

async function runCodexLogin(args: ParsedArgs): Promise<boolean> {
  try {
    await runAuthCommand({
      positional: ['auth', 'login'],
      flags: {
        provider: 'openai-codex',
        ...(hasFlag(args.flags, 'device-auth') ? { 'device-auth': true } : {}),
        ...(hasFlag(args.flags, 'no-device-fallback') ? { 'no-device-fallback': true } : {}),
      },
    });
    logOk('Codex login completed.');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn('Codex login failed or was cancelled.');
    console.log(`${MUTED}${message}${RESET}`);
    return false;
  }
}

async function persistOnboardingState(state: OnboardingState): Promise<void> {
  const configDir = getConfigDir();
  const workspacePath = expandHomePath(state.workspacePath);

  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(workspacePath, { recursive: true });

  await updateEnvFile({
    LLM_PROVIDER: state.provider,
    LLM_MODEL: state.model,
    LLM_API_KEY: state.apiKey,
    LLM_OLLAMA_HOST: state.ollamaHost,
    SPICY_MODE_ENABLED: state.spicyModeEnabled ? 'true' : 'false',
    SPICY_MAX_OBEDIENCE_ENABLED: state.spicyMaxObedienceEnabled ? 'true' : 'false',
    WORKSPACE_PATH: workspacePath,
    PORT: String(state.port),
  });

  const config = {
    llm: {
      provider: state.provider,
      model: state.model,
    },
    security: {
      spicyModeEnabled: state.spicyModeEnabled,
      spicyMaxObedienceEnabled: state.spicyMaxObedienceEnabled,
      workspacePath,
      allowedBinaries: DEFAULT_ALLOWED_BINARIES,
    },
    server: {
      port: state.port,
    },
  };

  await fs.writeFile(path.join(configDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function finishOnboarding(
  state: OnboardingState,
  options: {
    noPrompt: boolean;
    noRun: boolean;
  }
): Promise<void> {
  const chatUrl = getChatUrl();

  console.log('');
  for (const line of renderStaticPanel('Onboarding Complete', 'Keygate is configured and ready.')) {
    console.log(line);
  }
  logOk(`Provider: ${state.provider}`);
  logOk(`Model: ${state.model}`);
  logOk(`Spicy Mode Enabled: ${state.spicyModeEnabled}`);
  logOk(`Spicy Max Obedience: ${state.spicyMaxObedienceEnabled}`);
  logInfo(`Chat URL: ${chatUrl}`);

  if (options.noRun || options.noPrompt || !isPromptable()) {
    printManualRunInstructions(chatUrl);
    return;
  }

  const runNow = await selectMenu(
    'Run web app now or later manually?',
    [
      {
        label: 'Run now',
        description: 'Start keygate and open the web UI automatically.',
        value: true,
      },
      {
        label: 'Run later manually',
        description: 'Show command and URL only.',
        value: false,
      },
    ],
    0
  );

  if (!runNow) {
    printManualRunInstructions(chatUrl);
    return;
  }

  queueOpenUrl(chatUrl);
  logInfo('Starting keygate...');
  const exitCode = await runKeygateServe();
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

function printManualRunInstructions(chatUrl: string): void {
  console.log('');
  console.log(`${MUTED}Run manually when ready:${RESET}`);
  console.log(`${BOLD}  keygate${RESET}`);
  console.log(`${MUTED}Then open:${RESET} ${chatUrl}`);
}

function queueOpenUrl(url: string): void {
  setTimeout(() => {
    void openExternalUrl(url);
  }, 1200);
}

function getChatUrl(): string {
  const configuredUrl = process.env['KEYGATE_CHAT_URL']?.trim();
  if (!configuredUrl) {
    return DEFAULT_CHAT_URL;
  }
  return configuredUrl;
}

async function runKeygateServe(): Promise<number> {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  const command = entry.length > 0 ? process.execPath : 'keygate';
  const args = entry.length > 0 ? [entry] : [];

  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: process.env,
    });

    child.once('error', (error) => {
      reject(error);
    });

    child.once('exit', (code) => {
      resolve(code ?? 0);
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

    child.once('error', () => {
      resolve(false);
    });

    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

async function promptText(prompt: string, defaultValue: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const suffix = defaultValue.length > 0 ? ` [${defaultValue}]` : '';
    const answer = (await rl.question(`${INFO}›${RESET} ${prompt}${suffix}: `)).trim();
    if (answer.length === 0) {
      return defaultValue;
    }
    return answer;
  } finally {
    rl.close();
  }
}

async function promptSecret(prompt: string): Promise<string> {
  if (!isPromptable()) {
    return '';
  }

  const stdin = input as NodeJS.ReadStream;
  const previousRawMode = stdin.isRaw ?? false;
  let value = '';

  output.write(`${INFO}›${RESET} ${prompt}: `);

  return new Promise<string>((resolve, reject) => {
    const onData = (chunk: string | Buffer) => {
      const text = chunk.toString('utf8');

      for (const char of text) {
        if (char === '\r' || char === '\n') {
          cleanup();
          output.write('\n');
          resolve(value);
          return;
        }

        if (char === '\u0003') {
          cleanup();
          output.write('\n');
          reject(new Error('Onboarding cancelled.'));
          return;
        }

        if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }

        value += char;
        output.write('•');
      }
    };

    const cleanup = () => {
      stdin.off('data', onData);
      if (stdin.setRawMode) {
        stdin.setRawMode(previousRawMode);
      }
      stdin.pause();
    };

    if (stdin.setRawMode) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function selectMenu<T>(
  title: string,
  options: MenuOption<T>[],
  defaultIndex: number
): Promise<T> {
  if (!isPromptable()) {
    return options[Math.max(0, Math.min(defaultIndex, options.length - 1))]!.value;
  }

  if (options.length === 0) {
    throw new Error('selectMenu requires at least one option.');
  }

  const stdin = input as NodeJS.ReadStream;
  const previousRawMode = stdin.isRaw ?? false;
  let selectedIndex = Math.max(0, Math.min(defaultIndex, options.length - 1));
  let renderedLineCount = 0;

  readline.emitKeypressEvents(stdin);

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      stdin.off('keypress', onKeypress);
      if (stdin.setRawMode) {
        stdin.setRawMode(previousRawMode);
      }
      stdin.pause();
      clearRenderedFrame(renderedLineCount);
      output.write('\x1b[?25h');
      logInfo(`${title}: ${options[selectedIndex]!.label}`);
    };

    const render = () => {
      clearRenderedFrame(renderedLineCount);
      const lines = renderMenuFrame(title, options, selectedIndex);
      output.write(`${lines.join('\n')}\n`);
      renderedLineCount = lines.length;
    };

    const onKeypress = (str: string, key: { name?: string; ctrl?: boolean } | undefined) => {
      if (key?.ctrl && key.name === 'c') {
        cleanup();
        reject(new Error('Onboarding cancelled.'));
        return;
      }

      if (key?.name === 'up' || key?.name === 'k') {
        selectedIndex = selectedIndex <= 0 ? options.length - 1 : selectedIndex - 1;
        render();
        return;
      }

      if (key?.name === 'down' || key?.name === 'j') {
        selectedIndex = (selectedIndex + 1) % options.length;
        render();
        return;
      }

      if (key?.name === 'return' || key?.name === 'enter') {
        const value = options[selectedIndex]!.value;
        cleanup();
        resolve(value);
        return;
      }

      if (/^[1-9]$/.test(str)) {
        const numericIndex = Number.parseInt(str, 10) - 1;
        if (numericIndex >= 0 && numericIndex < options.length) {
          selectedIndex = numericIndex;
          render();
        }
      }
    };

    output.write('\x1b[?25l');
    if (stdin.setRawMode) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.on('keypress', onKeypress);
    render();
  });
}

function renderMenuFrame<T>(title: string, options: MenuOption<T>[], selectedIndex: number): string[] {
  const menuWidth = getPreferredMenuWidth();
  const innerWidth = menuWidth - 2;
  const contentWidth = innerWidth - 2;
  const lines: string[] = [];

  lines.push(`${ACCENT}┌${'─'.repeat(innerWidth)}┐${RESET}`);
  lines.push(`${ACCENT}│${RESET} ${BOLD}${padText(title, contentWidth)}${RESET} ${ACCENT}│${RESET}`);
  lines.push(`${ACCENT}├${'─'.repeat(innerWidth)}┤${RESET}`);

  options.forEach((option, index) => {
    const isSelected = index === selectedIndex;
    const marker = isSelected ? `${ACCENT}❯${RESET}` : ' ';
    const labelPrefix = `${index + 1}) `;
    const labelText = `${labelPrefix}${option.label}`;
    const label = isSelected ? `${BOLD}${padText(labelText, contentWidth - 2)}${RESET}` : padText(labelText, contentWidth - 2);
    lines.push(`${ACCENT}│${RESET} ${marker} ${label} ${ACCENT}│${RESET}`);
    lines.push(
      `${ACCENT}│${RESET}   ${MUTED}${padText(option.description, contentWidth - 3)}${RESET} ${ACCENT}│${RESET}`
    );
  });

  lines.push(`${ACCENT}└${'─'.repeat(innerWidth)}┘${RESET}`);
  lines.push(`${ACCENT_DIM}  ↑/↓ move • Enter select • 1-9 quick select • Ctrl+C cancel${RESET}`);

  return lines;
}

function renderStaticPanel(title: string, subtitle: string): string[] {
  const panelWidth = getPreferredMenuWidth();
  const innerWidth = panelWidth - 2;
  const contentWidth = innerWidth - 2;

  return [
    `${ACCENT}┌${'─'.repeat(innerWidth)}┐${RESET}`,
    `${ACCENT}│${RESET} ${BOLD}${padText(title, contentWidth)}${RESET} ${ACCENT}│${RESET}`,
    `${ACCENT}├${'─'.repeat(innerWidth)}┤${RESET}`,
    `${ACCENT}│${RESET} ${MUTED}${padText(subtitle, contentWidth)}${RESET} ${ACCENT}│${RESET}`,
    `${ACCENT}└${'─'.repeat(innerWidth)}┘${RESET}`,
  ];
}

function getPreferredMenuWidth(): number {
  const columns = output.columns ?? 80;
  return Math.max(64, Math.min(96, columns - 2));
}

function clearRenderedFrame(lineCount: number): void {
  if (lineCount <= 0) {
    return;
  }

  readline.moveCursor(output, 0, -lineCount);
  for (let index = 0; index < lineCount; index += 1) {
    readline.clearLine(output, 0);
    if (index < lineCount - 1) {
      readline.moveCursor(output, 0, 1);
    }
  }

  if (lineCount > 1) {
    readline.moveCursor(output, 0, -(lineCount - 1));
  }
  readline.cursorTo(output, 0);
}

function truncateText(value: string, maxLength: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxLength) {
    return value;
  }

  if (maxLength <= 1) {
    return chars.slice(0, maxLength).join('');
  }

  return `${chars.slice(0, maxLength - 1).join('')}…`;
}

function padText(value: string, maxLength: number): string {
  const truncated = truncateText(value, maxLength);
  const visibleLength = Array.from(truncated).length;
  if (visibleLength >= maxLength) {
    return truncated;
  }

  return `${truncated}${' '.repeat(maxLength - visibleLength)}`;
}

function expandHomePath(value: string): string {
  if (value === '~') {
    return os.homedir();
  }

  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

function isPromptable(): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

function logInfo(message: string): void {
  console.log(`${INFO}i${RESET} ${message}`);
}

function logOk(message: string): void {
  console.log(`${SUCCESS}✓${RESET} ${message}`);
}

function logWarn(message: string): void {
  console.log(`${WARN}!${RESET} ${message}`);
}
