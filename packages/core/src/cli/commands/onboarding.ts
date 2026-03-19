import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { getFlagString, hasFlag, type ParsedArgs } from '../argv.js';
import { getConfigDir, getDefaultWorkspacePath, updateKeygateFile } from '../../config/env.js';
import { runAuthCommand } from './auth.js';

type ProviderChoice = 'openai' | 'openai-codex' | 'gemini' | 'ollama';

interface OnboardingState {
  mode: 'quickstart' | 'advanced';
  // LLM
  provider: ProviderChoice;
  model: string;
  apiKey: string;
  ollamaHost: string;
  // Security
  spicyModeEnabled: boolean;
  spicyMaxObedienceEnabled: boolean;
  // Server
  port: number;
  host: string;
  apiToken: string;
  // Workspace
  workspacePath: string;
  // Channels
  discord?: { token: string; prefix: string; dmPolicy: string };
  slack?: { botToken: string; appToken: string; signingSecret: string; dmPolicy: string };
  telegram?: { token: string; dmPolicy: string; groupMode: string };
  whatsapp?: { dmPolicy: string; groupMode: string };
  // Browser
  browserDomainPolicy: 'none' | 'allowlist' | 'blocklist';
  // Memory
  memoryBackend: 'lancedb' | 'sqlite-vec';
}

interface MenuOption<T> {
  label: string;
  description: string;
  value: T;
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const UNDERLINE = '\x1b[4m';
const INVERSE = '\x1b[7m';
const ACCENT = '\x1b[38;2;255;90;45m';
const ACCENT_DIM = '\x1b[38;2;209;74;34m';
const INFO = '\x1b[38;2;255;138;91m';
const SUCCESS = '\x1b[38;2;47;191;113m';
const WARN = '\x1b[38;2;255;176;32m';
const ERROR = '\x1b[38;2;226;61;45m';
const MUTED = '\x1b[38;2;139;127;119m';

const S = {
  STEP_ACTIVE: '◆',
  STEP_DONE: '◇',
  STEP_PENDING: '○',
  BAR: '│',
  BAR_END: '└',
  RADIO_ON: '●',
  RADIO_OFF: '○',
  CHECK_ON: '◼',
  CHECK_OFF: '◻',
  BULLET: '•',
  CHECK: '✓',
  CROSS: '✗',
  WARN_ICON: '▲',
  BOX_TL: '╭',
  BOX_TR: '╮',
  BOX_BL: '╰',
  BOX_BR: '╯',
  BOX_H: '─',
  BOX_V: '│',
};

const DEFAULT_CHAT_URL = 'http://127.0.0.1:18790';
const DEFAULT_ALLOWED_BINARIES = ['git', 'ls', 'npm', 'cat', 'node', 'python3'];

// ── Persistent keypress dispatcher ─────────────────────────────
// A single keypress listener stays attached at all times so that
// readline's internal emitKeypressEvents handler never sees zero
// listeners and never self-destructs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _keypressHandler: ((...args: any[]) => void) | null = null;
let _stdinActivated = false;

function initKeypressDispatcher(): void {
  if (_stdinActivated) return;
  const stdin = input as NodeJS.ReadStream;
  readline.emitKeypressEvents(stdin);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stdin.on('keypress', (...args: any[]) => {
    _keypressHandler?.(...args);
  });
  _stdinActivated = true;
}

function activateStdin(stdin: NodeJS.ReadStream): void {
  initKeypressDispatcher();
  if (stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();
}

function deactivateStdin(stdin: NodeJS.ReadStream, restoreRawMode: boolean): void {
  _keypressHandler = null;
  if (stdin.setRawMode) stdin.setRawMode(restoreRawMode);
  stdin.pause();
}

export async function runOnboardingCommand(args: ParsedArgs): Promise<void> {
  const promptable = isPromptable();
  const noPrompt = hasFlag(args.flags, 'no-prompt') || !promptable;
  const nonInteractive = hasFlag(args.flags, 'non-interactive') || noPrompt;
  const defaultsOnly = hasFlag(args.flags, 'defaults') || nonInteractive;
  const noRun = hasFlag(args.flags, 'no-run');

  const state = createDefaultState();
  const workspaceFlag = getFlagString(args.flags, 'workspace-path', '').trim();
  if (workspaceFlag.length > 0) {
    state.workspacePath = expandHomePath(workspaceFlag);
  }

  // Apply CLI flags for non-interactive mode
  if (nonInteractive) {
    applyCliFlags(state, args);
  }

  printBanner();

  if (defaultsOnly) {
    if (!promptable) {
      logWarn('No interactive TTY detected. Applying deterministic defaults.');
    } else {
      logInfo('Applying deterministic defaults.');
    }

    await persistOnboardingState(state);
    await finishOnboarding(state, { noPrompt: true, noRun });
    return;
  }

  // Phase 1: Existing config detection
  const configDir = getConfigDir();
  const configPath = path.join(configDir, 'config.json');
  let existingConfig: Record<string, unknown> | null = null;
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    existingConfig = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // No existing config
  }

  if (existingConfig) {
    const llm = existingConfig['llm'] as Record<string, unknown> | undefined;
    const server = existingConfig['server'] as Record<string, unknown> | undefined;
    printNote('Existing Configuration Found', [
      `Provider: ${llm?.['provider'] ?? 'unknown'}`,
      `Model: ${llm?.['model'] ?? 'unknown'}`,
      `Port: ${server?.['port'] ?? '18790'}`,
    ].join('\n'));

    const action = await selectMenu(
      'Existing configuration detected',
      [
        { label: 'Modify', description: 'Walk through setup with current values as defaults.', value: 'modify' as const },
        { label: 'Reset', description: 'Clear config and start fresh.', value: 'reset' as const },
        { label: 'Keep', description: 'Leave existing configuration unchanged.', value: 'keep' as const },
      ],
      0
    );

    emitRailSpacer();

    if (action === 'keep') {
      printOutro([
        ['keygate', 'Start the gateway'],
        ['keygate tui', 'Terminal chat'],
        ['keygate doctor', 'Verify setup'],
      ]);
      return;
    }

    if (action === 'reset') {
      try { await fs.unlink(configPath); } catch { /* ignore */ }
      try { await fs.unlink(path.join(configDir, '.env')); } catch { /* ignore */ }
      logInfo('Configuration cleared.');
      emitRailSpacer();
    }
    // 'modify' continues through the wizard with defaults
  } else {
    // Welcome step for first-time setup
    const continueSetup = await selectMenu(
      'Welcome to Keygate',
      [
        { label: 'Continue setup', description: 'Configure provider, security, and more.', value: true },
        { label: 'Exit', description: 'Leave defaults unchanged.', value: false },
      ],
      0
    );

    emitRailSpacer();

    if (!continueSetup) {
      console.log(`${ACCENT_DIM}${S.BAR_END}${RESET}  ${MUTED}Onboarding cancelled.${RESET}\n`);
      return;
    }
  }

  // Phase 2: QuickStart vs Advanced
  const setupMode = await selectMenu(
    'How would you like to set up?',
    [
      { label: 'QuickStart (recommended)', description: 'Sensible defaults, minimal prompts.', value: 'quickstart' as const },
      { label: 'Advanced', description: 'Full control over every setting.', value: 'advanced' as const },
    ],
    0
  );
  state.mode = setupMode;
  emitRailSpacer();

  // Phase 3: Security mode
  const spicyMode = await selectMenu(
    'Choose security mode',
    [
      { label: 'Safe Mode (recommended)', description: 'Sandboxed workspace with safer defaults.', value: false },
      { label: 'Spicy Mode', description: 'Full host access. High-risk, unrestricted.', value: true },
    ],
    0
  );
  emitRailSpacer();

  if (spicyMode) {
    const ack = await promptText(
      'Type I ACCEPT THE RISK to enable Spicy Mode (or press Enter for Safe Mode)',
      ''
    );
    if (ack === 'I ACCEPT THE RISK') {
      state.spicyModeEnabled = true;
      emitRailSpacer();

      const maxObedience = await promptConfirm('Enable Max Obedience? (removes all safety guardrails)', false);
      state.spicyMaxObedienceEnabled = maxObedience;
    } else {
      state.spicyModeEnabled = false;
    }
  } else {
    state.spicyModeEnabled = false;
  }
  emitRailSpacer();

  // Phase 4: Provider & Model
  await collectProviderSettings(state, args);
  emitRailSpacer();

  // Phase 5: Gateway Server Configuration (Advanced only)
  if (state.mode === 'advanced') {
    const portStr = await promptText('Gateway port', '18790');
    const portNum = Number.parseInt(portStr, 10);
    if (portNum >= 1024 && portNum <= 65535) {
      state.port = portNum;
    } else {
      logWarn(`Invalid port "${portStr}", using default 18790.`);
      state.port = 18790;
    }
    emitRailSpacer();

    const hostChoice = await selectMenu(
      'Server bind address',
      [
        { label: 'Loopback (127.0.0.1)', description: 'Most secure, local access only.', value: '127.0.0.1' },
        { label: 'All interfaces (0.0.0.0)', description: 'LAN access, less secure.', value: '0.0.0.0' },
        { label: 'Custom IP', description: 'Enter a specific bind address.', value: 'custom' },
      ],
      0
    );

    if (hostChoice === 'custom') {
      state.host = await promptText('Bind IP address', '127.0.0.1');
    } else {
      state.host = hostChoice;
    }
    emitRailSpacer();
  }

  // Phase 6: API Token (both modes)
  if (state.mode === 'advanced') {
    const tokenChoice = await selectMenu(
      'API token for gateway authentication',
      [
        { label: 'Auto-generate (recommended)', description: 'Generate a secure 48-byte hex token.', value: 'auto' },
        { label: 'Enter manually', description: 'Provide your own token.', value: 'manual' },
        { label: 'Skip', description: 'No authentication (not recommended).', value: 'skip' },
      ],
      0
    );
    emitRailSpacer();

    if (tokenChoice === 'manual') {
      state.apiToken = await promptSecret('Enter API token');
      emitRailSpacer();
    } else if (tokenChoice === 'skip') {
      state.apiToken = '';
      printNote(`${S.WARN_ICON} Warning`, 'Gateway will have no authentication. Anyone with network access can control your AI agent.', WARN);
    }
    // 'auto' keeps the pre-generated token
  }

  if (state.apiToken.length > 0) {
    const masked = state.apiToken.slice(0, 8) + '…' + state.apiToken.slice(-4);
    printNote('API Token Generated', `Save this token — you'll need it for API access:\n${masked}`);
  }

  // Phase 7: Channel Configuration (Advanced only)
  if (state.mode === 'advanced') {
    const channels = await promptMultiSelect<string>(
      'Configure messaging channels',
      [
        { label: 'Discord', description: 'Bot token + command prefix.', value: 'discord' },
        { label: 'Slack', description: 'Bot, app tokens + signing secret.', value: 'slack' },
        { label: 'Telegram', description: 'BotFather token.', value: 'telegram' },
        { label: 'WhatsApp', description: 'QR-based linking (post-setup).', value: 'whatsapp' },
      ]
    );
    emitRailSpacer();

    if (channels.includes('discord')) {
      const token = await promptSecret('Discord bot token');
      const prefix = await promptText('Discord command prefix', '!keygate ');
      const dmPolicy = await selectMenu(
        'Discord DM policy',
        [
          { label: 'Pairing (recommended)', description: 'Users must pair before chatting.', value: 'pairing' },
          { label: 'Open', description: 'Anyone can DM the bot.', value: 'open' },
          { label: 'Closed', description: 'No DMs accepted.', value: 'closed' },
        ],
        0
      );
      state.discord = { token, prefix, dmPolicy };
      emitRailSpacer();
    }

    if (channels.includes('slack')) {
      const botToken = await promptSecret('Slack bot token (xoxb-...)');
      const appToken = await promptSecret('Slack app token (xapp-...)');
      const signingSecret = await promptSecret('Slack signing secret');
      const dmPolicy = await selectMenu(
        'Slack DM policy',
        [
          { label: 'Pairing', description: 'Users must pair first.', value: 'pairing' },
          { label: 'Open', description: 'Anyone can DM.', value: 'open' },
          { label: 'Closed', description: 'No DMs.', value: 'closed' },
        ],
        0
      );
      state.slack = { botToken, appToken, signingSecret, dmPolicy };
      emitRailSpacer();
    }

    if (channels.includes('telegram')) {
      const token = await promptSecret('Telegram bot token (from @BotFather)');
      const dmPolicy = await selectMenu(
        'Telegram DM policy',
        [
          { label: 'Pairing', description: 'Users must pair first.', value: 'pairing' },
          { label: 'Open', description: 'Anyone can message.', value: 'open' },
          { label: 'Closed', description: 'No DMs.', value: 'closed' },
        ],
        0
      );
      const groupMode = await selectMenu(
        'Telegram group mode',
        [
          { label: 'Closed', description: 'No group messages.', value: 'closed' },
          { label: 'Open', description: 'Respond in all groups.', value: 'open' },
          { label: 'Mention only', description: 'Respond only when mentioned.', value: 'mention' },
        ],
        0
      );
      state.telegram = { token, dmPolicy, groupMode };
      emitRailSpacer();
    }

    if (channels.includes('whatsapp')) {
      printNote('WhatsApp', 'WhatsApp uses QR-based linking.\nRun `keygate channels whatsapp login` after setup to scan the QR code.');
      const dmPolicy = await selectMenu(
        'WhatsApp DM policy',
        [
          { label: 'Pairing', description: 'Users must pair first.', value: 'pairing' },
          { label: 'Open', description: 'Anyone can message.', value: 'open' },
          { label: 'Closed', description: 'No DMs.', value: 'closed' },
        ],
        0
      );
      const groupMode = await selectMenu(
        'WhatsApp group mode',
        [
          { label: 'Closed', description: 'No group messages.', value: 'closed' },
          { label: 'Selected', description: 'Only selected groups.', value: 'selected' },
          { label: 'Open', description: 'All groups.', value: 'open' },
        ],
        0
      );
      state.whatsapp = { dmPolicy, groupMode };
      emitRailSpacer();
    }
  }

  // Phase 8: Browser policy (Advanced only)
  if (state.mode === 'advanced') {
    const browserPolicy = await selectMenu(
      'Browser domain policy',
      [
        { label: 'No restrictions', description: 'Agent can browse any domain.', value: 'none' as const },
        { label: 'Allowlist only', description: 'Restrict to listed domains.', value: 'allowlist' as const },
        { label: 'Blocklist', description: 'Block specific domains.', value: 'blocklist' as const },
      ],
      0
    );
    state.browserDomainPolicy = browserPolicy;
    emitRailSpacer();
  }

  // Phase 9: Memory backend (Advanced only)
  if (state.mode === 'advanced') {
    const memBackend = await selectMenu(
      'Memory backend',
      [
        { label: 'LanceDB (recommended)', description: 'Vector search, full-featured.', value: 'lancedb' as const },
        { label: 'SQLite-vec', description: 'Lighter, embedded alternative.', value: 'sqlite-vec' as const },
      ],
      0
    );
    state.memoryBackend = memBackend;
    emitRailSpacer();
  }

  // Phase 10: Persist & Finish
  await persistOnboardingState(state);
  await finishOnboarding(state, { noPrompt: false, noRun });
}

function applyCliFlags(state: OnboardingState, args: ParsedArgs): void {
  const provider = getFlagString(args.flags, 'provider', '').trim();
  if (provider === 'openai' || provider === 'openai-codex' || provider === 'gemini' || provider === 'ollama') {
    state.provider = provider;
  }
  const model = getFlagString(args.flags, 'model', '').trim();
  if (model.length > 0) state.model = model;
  const apiKey = getFlagString(args.flags, 'api-key', '').trim();
  if (apiKey.length > 0) state.apiKey = apiKey;
  const port = getFlagString(args.flags, 'port', '').trim();
  if (port.length > 0) {
    const p = Number.parseInt(port, 10);
    if (p >= 1024 && p <= 65535) state.port = p;
  }
  const host = getFlagString(args.flags, 'host', '').trim();
  if (host.length > 0) state.host = host;
  const apiToken = getFlagString(args.flags, 'api-token', '').trim();
  if (apiToken.length > 0) state.apiToken = apiToken;
  if (hasFlag(args.flags, 'spicy')) state.spicyModeEnabled = true;
  const discordToken = getFlagString(args.flags, 'discord-token', '').trim();
  if (discordToken.length > 0) {
    state.discord = { token: discordToken, prefix: '!keygate ', dmPolicy: 'pairing' };
  }
  const telegramToken = getFlagString(args.flags, 'telegram-token', '').trim();
  if (telegramToken.length > 0) {
    state.telegram = { token: telegramToken, dmPolicy: 'pairing', groupMode: 'closed' };
  }
  const memBackend = getFlagString(args.flags, 'memory-backend', '').trim();
  if (memBackend === 'lancedb' || memBackend === 'sqlite-vec') state.memoryBackend = memBackend;
}

function createDefaultState(): OnboardingState {
  return {
    mode: 'quickstart',
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: '',
    ollamaHost: '',
    spicyModeEnabled: false,
    spicyMaxObedienceEnabled: false,
    workspacePath: getDefaultWorkspacePath(),
    port: 18790,
    host: '127.0.0.1',
    apiToken: crypto.randomBytes(48).toString('hex'),
    browserDomainPolicy: 'none',
    memoryBackend: 'lancedb',
  };
}

async function collectProviderSettings(state: OnboardingState, args: ParsedArgs): Promise<void> {
  while (true) {
    const provider = await selectMenu(
      'Choose your LLM provider',
      [
        { label: 'OpenAI', description: 'GPT-4o, o3, o3-mini.', value: 'openai' as const },
        { label: 'OpenAI Codex (ChatGPT OAuth)', description: 'Login via browser.', value: 'openai-codex' as const },
        { label: 'Google Gemini', description: 'Gemini 2.0 Flash, Pro.', value: 'gemini' as const },
        { label: 'Ollama', description: 'Local models via Ollama.', value: 'ollama' as const },
        { label: 'Skip for now', description: 'Use default config.', value: 'skip' as const },
      ],
      0
    );
    emitRailSpacer();

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

  const envUpdates: Record<string, string> = {
    LLM_PROVIDER: state.provider,
    LLM_MODEL: state.model,
    LLM_API_KEY: state.apiKey,
    LLM_OLLAMA_HOST: state.ollamaHost,
    SPICY_MODE_ENABLED: state.spicyModeEnabled ? 'true' : 'false',
    SPICY_MAX_OBEDIENCE_ENABLED: state.spicyMaxObedienceEnabled ? 'true' : 'false',
    WORKSPACE_PATH: workspacePath,
    PORT: String(state.port),
    KEYGATE_SERVER_HOST: state.host,
    KEYGATE_SERVER_API_TOKEN: state.apiToken,
    KEYGATE_MEMORY_BACKEND: state.memoryBackend,
  };

  if (state.discord) {
    envUpdates['DISCORD_TOKEN'] = state.discord.token;
    envUpdates['DISCORD_PREFIX'] = state.discord.prefix;
    envUpdates['DISCORD_DM_POLICY'] = state.discord.dmPolicy;
  }

  if (state.slack) {
    envUpdates['SLACK_BOT_TOKEN'] = state.slack.botToken;
    envUpdates['SLACK_APP_TOKEN'] = state.slack.appToken;
    envUpdates['SLACK_SIGNING_SECRET'] = state.slack.signingSecret;
    envUpdates['SLACK_DM_POLICY'] = state.slack.dmPolicy;
  }

  if (state.telegram) {
    envUpdates['TELEGRAM_BOT_TOKEN'] = state.telegram.token;
    envUpdates['TELEGRAM_DM_POLICY'] = state.telegram.dmPolicy;
    envUpdates['TELEGRAM_GROUP_MODE'] = state.telegram.groupMode;
  }

  await updateKeygateFile(envUpdates);

  const config: Record<string, unknown> = {
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
      host: state.host,
      port: state.port,
      apiToken: state.apiToken,
    },
    memory: {
      backend: {
        active: state.memoryBackend,
      },
    },
  };

  if (state.discord) {
    config['discord'] = {
      token: state.discord.token,
      prefix: state.discord.prefix,
      dmPolicy: state.discord.dmPolicy,
    };
  }

  if (state.slack) {
    config['slack'] = {
      botToken: state.slack.botToken,
      appToken: state.slack.appToken,
      signingSecret: state.slack.signingSecret,
      dmPolicy: state.slack.dmPolicy,
    };
  }

  if (state.telegram) {
    config['telegram'] = {
      token: state.telegram.token,
      dmPolicy: state.telegram.dmPolicy,
      groupMode: state.telegram.groupMode,
    };
  }

  if (state.whatsapp) {
    config['whatsapp'] = {
      dmPolicy: state.whatsapp.dmPolicy,
      groupMode: state.whatsapp.groupMode,
    };
  }

  if (state.browserDomainPolicy !== 'none') {
    config['browser'] = {
      domainPolicy: state.browserDomainPolicy,
    };
  }

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

  // Build summary rows
  const summaryRows: Array<[string, string]> = [
    ['Provider', state.provider],
    ['Model', state.model],
    ['Security', state.spicyModeEnabled ? (state.spicyMaxObedienceEnabled ? 'Spicy + Max Obedience' : 'Spicy Mode') : 'Safe Mode'],
    ['Server', `${state.host}:${state.port}`],
  ];

  if (state.apiToken.length > 0) {
    summaryRows.push(['API Token', state.apiToken.slice(0, 8) + '…' + state.apiToken.slice(-4)]);
  }

  const configuredChannels: string[] = [];
  if (state.discord) configuredChannels.push('Discord');
  if (state.slack) configuredChannels.push('Slack');
  if (state.telegram) configuredChannels.push('Telegram');
  if (state.whatsapp) configuredChannels.push('WhatsApp');
  summaryRows.push(['Channels', configuredChannels.length > 0 ? configuredChannels.join(', ') : 'None']);
  summaryRows.push(['Browser', state.browserDomainPolicy === 'none' ? 'No restrictions' : state.browserDomainPolicy]);
  summaryRows.push(['Memory', state.memoryBackend]);
  summaryRows.push(['Workspace', state.workspacePath]);

  printSummaryTable(summaryRows);

  if (options.noRun || options.noPrompt || !isPromptable()) {
    const nextSteps: Array<[string, string]> = [
      ['keygate', 'Start the gateway'],
      ['keygate tui', 'Terminal chat'],
      ['keygate doctor', 'Verify setup'],
    ];
    if (state.whatsapp) {
      nextSteps.push(['keygate channels whatsapp login', 'Link WhatsApp']);
    }
    printOutro(nextSteps);
    return;
  }

  const runNow = await selectMenu(
    'Start the gateway now?',
    [
      { label: 'Start now', description: `Launch keygate and open ${chatUrl}`, value: true },
      { label: 'Exit', description: 'Show manual start command.', value: false },
    ],
    0
  );
  emitRailSpacer();

  if (!runNow) {
    const nextSteps: Array<[string, string]> = [
      ['keygate', 'Start the gateway'],
      ['keygate tui', 'Terminal chat'],
      ['keygate doctor', 'Verify setup'],
    ];
    if (state.whatsapp) {
      nextSteps.push(['keygate channels whatsapp login', 'Link WhatsApp']);
    }
    printOutro(nextSteps);
    return;
  }

  const nextSteps: Array<[string, string]> = [
    ['keygate tui', 'Terminal chat'],
    ['keygate doctor', 'Verify setup'],
  ];
  if (state.whatsapp) {
    nextSteps.push(['keygate channels whatsapp login', 'Link WhatsApp']);
  }
  printOutro(nextSteps);

  queueOpenUrl(chatUrl);
  logInfo('Starting keygate...');
  const exitCode = await runKeygateServe();
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
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
  if (!isPromptable()) {
    return defaultValue;
  }

  const stdin = input as NodeJS.ReadStream;
  const previousRawMode = stdin.isRaw ?? false;
  let value = '';

  const defaultHint = defaultValue.length > 0 ? `  ${MUTED}(default: ${defaultValue})${RESET}` : '';
  const prefix = `${ACCENT_DIM}${S.BAR}${RESET}  `;
  const prefixLen = 3; // '│  ' = 3 visible chars

  output.write('\x1b[?25h');
  output.write(`${ACCENT}${S.STEP_ACTIVE}${RESET}  ${BOLD}${prompt}${RESET}${defaultHint}\n`);
  output.write(prefix);

  const redrawInputLine = () => {
    readline.cursorTo(output, 0);
    readline.clearLine(output, 0);
    output.write(`${prefix}${value}`);
  };

  return new Promise<string>((resolve, reject) => {
    const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
      if (key?.ctrl && key.name === 'c') {
        cleanup();
        output.write('\n');
        reject(new Error('Onboarding cancelled.'));
        return;
      }

      if (key?.name === 'return' || key?.name === 'enter') {
        cleanup();
        const result = value.trim().length === 0 ? defaultValue : value.trim();
        // Clear the 2-line active frame and replace with submitted state
        readline.cursorTo(output, 0);
        readline.clearLine(output, 0);
        readline.moveCursor(output, 0, -1);
        readline.cursorTo(output, 0);
        readline.clearLine(output, 0);
        output.write(`${SUCCESS}${S.STEP_DONE}${RESET}  ${MUTED}${prompt}${RESET}\n`);
        output.write(`${ACCENT_DIM}${S.BAR}${RESET}  ${DIM}${result}${RESET}\n`);
        resolve(result);
        return;
      }

      if (key?.name === 'backspace') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          redrawInputLine();
        }
        return;
      }

      if (str && !key?.ctrl && str.length === 1 && str >= ' ') {
        value += str;
        redrawInputLine();
      }
    };

    const cleanup = () => deactivateStdin(stdin, previousRawMode);

    _keypressHandler = onKeypress;
    activateStdin(stdin);
  });
}

async function promptSecret(prompt: string): Promise<string> {
  if (!isPromptable()) {
    return '';
  }

  const stdin = input as NodeJS.ReadStream;
  const previousRawMode = stdin.isRaw ?? false;
  let value = '';

  const prefix = `${ACCENT_DIM}${S.BAR}${RESET}  `;

  output.write(`${ACCENT}${S.STEP_ACTIVE}${RESET}  ${BOLD}${prompt}${RESET}\n`);
  output.write(prefix);

  const redrawInputLine = () => {
    readline.cursorTo(output, 0);
    readline.clearLine(output, 0);
    output.write(`${prefix}${S.BULLET.repeat(value.length)}`);
  };

  return new Promise<string>((resolve, reject) => {
    const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
      if (key?.ctrl && key.name === 'c') {
        cleanup();
        output.write('\n');
        reject(new Error('Onboarding cancelled.'));
        return;
      }

      if (key?.name === 'return' || key?.name === 'enter') {
        cleanup();
        readline.cursorTo(output, 0);
        readline.clearLine(output, 0);
        readline.moveCursor(output, 0, -1);
        readline.cursorTo(output, 0);
        readline.clearLine(output, 0);
        output.write(`${SUCCESS}${S.STEP_DONE}${RESET}  ${MUTED}${prompt}${RESET}\n`);
        output.write(`${ACCENT_DIM}${S.BAR}${RESET}  ${DIM}${S.BULLET.repeat(8)}${RESET}\n`);
        resolve(value);
        return;
      }

      if (key?.name === 'backspace') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          redrawInputLine();
        }
        return;
      }

      if (str && !key?.ctrl && str.length === 1 && str >= ' ') {
        value += str;
        redrawInputLine();
      }
    };

    const cleanup = () => deactivateStdin(stdin, previousRawMode);

    _keypressHandler = onKeypress;
    activateStdin(stdin);
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

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      deactivateStdin(stdin, previousRawMode);
      clearRenderedFrame(renderedLineCount);
      output.write('\x1b[?25h');
    };

    const submit = () => {
      const value = options[selectedIndex]!.value;
      cleanup();
      const lines = renderSelectSubmitted(title, options[selectedIndex]!.label);
      output.write(`${lines.join('\n')}\n`);
      resolve(value);
    };

    const render = () => {
      clearRenderedFrame(renderedLineCount);
      const lines = renderSelectFrame(title, options, selectedIndex);
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
        submit();
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
    _keypressHandler = onKeypress;
    activateStdin(stdin);
    render();
  });
}

function renderSelectFrame<T>(title: string, options: MenuOption<T>[], selectedIndex: number): string[] {
  const lines: string[] = [];
  const showHints = (output.columns ?? 80) > 80;

  lines.push(`${ACCENT}${S.STEP_ACTIVE}${RESET}  ${BOLD}${title}${RESET}`);

  options.forEach((option, index) => {
    const isSelected = index === selectedIndex;
    const marker = isSelected ? `${ACCENT}${S.RADIO_ON}${RESET}` : `${MUTED}${S.RADIO_OFF}${RESET}`;
    const num = `${index + 1}. `;
    const label = isSelected ? `${BOLD}${num}${option.label}${RESET}` : `${num}${option.label}`;
    const hint = option.description && showHints
      ? `  ${isSelected ? MUTED : DIM}${option.description}${RESET}`
      : '';
    lines.push(`${ACCENT_DIM}${S.BAR}${RESET}  ${marker} ${label}${hint}`);
  });

  lines.push(`${ACCENT_DIM}${S.BAR}${RESET}`);
  lines.push(`${ACCENT_DIM}${S.BAR}${RESET}  ${MUTED}${DIM}↑/↓ move ${S.BULLET} Enter select ${S.BULLET} 1-${options.length} jump${RESET}`);

  return lines;
}

function renderSelectSubmitted(title: string, selectedLabel: string): string[] {
  return [
    `${SUCCESS}${S.STEP_DONE}${RESET}  ${MUTED}${title}${RESET}`,
    `${ACCENT_DIM}${S.BAR}${RESET}  ${DIM}${selectedLabel}${RESET}`,
  ];
}

// ── New UI Primitives ──────────────────────────────────────────

async function promptConfirm(message: string, defaultYes = true): Promise<boolean> {
  if (!isPromptable()) {
    return defaultYes;
  }

  const stdin = input as NodeJS.ReadStream;
  const previousRawMode = stdin.isRaw ?? false;
  let current = defaultYes;
  let renderedLineCount = 0;

  return new Promise<boolean>((resolve, reject) => {
    const renderFrame = (): string[] => {
      const yes = current ? `${BOLD}${UNDERLINE}Yes${RESET}` : `${DIM}Yes${RESET}`;
      const no = current ? `${DIM}No${RESET}` : `${BOLD}${UNDERLINE}No${RESET}`;
      return [
        `${ACCENT}${S.STEP_ACTIVE}${RESET}  ${BOLD}${message}${RESET}`,
        `${ACCENT_DIM}${S.BAR}${RESET}  ${yes} / ${no}`,
        `${ACCENT_DIM}${S.BAR}${RESET}`,
        `${ACCENT_DIM}${S.BAR}${RESET}  ${MUTED}${DIM}y/n toggle ${S.BULLET} ←/→ switch ${S.BULLET} Enter confirm${RESET}`,
      ];
    };

    const cleanup = () => {
      deactivateStdin(stdin, previousRawMode);
      clearRenderedFrame(renderedLineCount);
      output.write('\x1b[?25h');
    };

    const render = () => {
      clearRenderedFrame(renderedLineCount);
      const lines = renderFrame();
      output.write(`${lines.join('\n')}\n`);
      renderedLineCount = lines.length;
    };

    const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean } | undefined) => {
      if (key?.ctrl && key.name === 'c') {
        cleanup();
        reject(new Error('Onboarding cancelled.'));
        return;
      }

      if (key?.name === 'y') {
        current = true;
        render();
        return;
      }

      if (key?.name === 'n') {
        current = false;
        render();
        return;
      }

      if (key?.name === 'left' || key?.name === 'right') {
        current = !current;
        render();
        return;
      }

      if (key?.name === 'return' || key?.name === 'enter') {
        cleanup();
        output.write(`${SUCCESS}${S.STEP_DONE}${RESET}  ${MUTED}${message}${RESET}\n`);
        output.write(`${ACCENT_DIM}${S.BAR}${RESET}  ${DIM}${current ? 'Yes' : 'No'}${RESET}\n`);
        resolve(current);
      }
    };

    output.write('\x1b[?25l');
    _keypressHandler = onKeypress;
    activateStdin(stdin);
    render();
  });
}

async function promptMultiSelect<T>(
  title: string,
  options: MenuOption<T>[],
  preSelected: T[] = []
): Promise<T[]> {
  if (!isPromptable()) {
    return preSelected;
  }

  if (options.length === 0) {
    return [];
  }

  const stdin = input as NodeJS.ReadStream;
  const previousRawMode = stdin.isRaw ?? false;
  let focusIndex = 0;
  const checked = options.map((opt) => preSelected.includes(opt.value));
  let renderedLineCount = 0;

  return new Promise<T[]>((resolve, reject) => {
    const renderFrame = (): string[] => {
      const lines: string[] = [];
      const showHints = (output.columns ?? 80) > 80;

      lines.push(`${ACCENT}${S.STEP_ACTIVE}${RESET}  ${BOLD}${title}${RESET}`);

      options.forEach((option, index) => {
        const isFocused = index === focusIndex;
        const isChecked = checked[index];
        const marker = isChecked ? `${ACCENT}${S.CHECK_ON}${RESET}` : `${MUTED}${S.CHECK_OFF}${RESET}`;
        const label = isFocused ? `${BOLD}${option.label}${RESET}` : option.label;
        const hint = option.description && showHints
          ? `  ${isFocused ? MUTED : DIM}${option.description}${RESET}`
          : '';
        lines.push(`${ACCENT_DIM}${S.BAR}${RESET}  ${marker} ${label}${hint}`);
      });

      lines.push(`${ACCENT_DIM}${S.BAR}${RESET}`);
      lines.push(`${ACCENT_DIM}${S.BAR}${RESET}  ${MUTED}${DIM}Space toggle ${S.BULLET} ↑/↓ move ${S.BULLET} a all ${S.BULLET} Enter confirm${RESET}`);

      return lines;
    };

    const cleanup = () => {
      deactivateStdin(stdin, previousRawMode);
      clearRenderedFrame(renderedLineCount);
      output.write('\x1b[?25h');
    };

    const render = () => {
      clearRenderedFrame(renderedLineCount);
      const lines = renderFrame();
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
        focusIndex = focusIndex <= 0 ? options.length - 1 : focusIndex - 1;
        render();
        return;
      }

      if (key?.name === 'down' || key?.name === 'j') {
        focusIndex = (focusIndex + 1) % options.length;
        render();
        return;
      }

      if (key?.name === 'space' || str === ' ') {
        checked[focusIndex] = !checked[focusIndex];
        render();
        return;
      }

      if (str === 'a') {
        const allChecked = checked.every(Boolean);
        checked.fill(!allChecked);
        render();
        return;
      }

      if (key?.name === 'return' || key?.name === 'enter') {
        const selected = options.filter((_, i) => checked[i]).map((o) => o.value);
        const selectedLabels = options.filter((_, i) => checked[i]).map((o) => o.label);
        cleanup();
        output.write(`${SUCCESS}${S.STEP_DONE}${RESET}  ${MUTED}${title}${RESET}\n`);
        output.write(`${ACCENT_DIM}${S.BAR}${RESET}  ${DIM}${selectedLabels.join(', ') || 'None'}${RESET}\n`);
        resolve(selected);
      }
    };

    output.write('\x1b[?25l');
    _keypressHandler = onKeypress;
    activateStdin(stdin);
    render();
  });
}

function emitRailSpacer(): void {
  console.log(`${ACCENT_DIM}${S.BAR}${RESET}`);
}

function printBanner(): void {
  const w = getPreferredMenuWidth();
  const inner = w - 4;
  const pad = (text: string, total: number) => text + ' '.repeat(Math.max(0, total - stripAnsi(text).length));

  const artLines = [
    `${BOLD}${ACCENT}╦╔═╔═╗╦ ╦╔═╗╔═╗╔╦╗╔═╗${RESET}`,
    `${BOLD}${ACCENT}╠╩╗║╣ ╚╦╝║ ╦╠═╣ ║ ║╣${RESET}`,
    `${BOLD}${ACCENT}╩ ╩╚═╝ ╩ ╚═╝╩ ╩ ╩ ╚═╝${RESET}`,
  ];
  const subtitle = `${MUTED}Setup Wizard${RESET}`;

  console.log('');
  console.log(`  ${ACCENT_DIM}${S.BOX_TL}${S.BOX_H.repeat(inner)}${S.BOX_TR}${RESET}`);
  console.log(`  ${ACCENT_DIM}${S.BOX_V}${RESET}${' '.repeat(inner)}${ACCENT_DIM}${S.BOX_V}${RESET}`);
  for (const line of artLines) {
    console.log(`  ${ACCENT_DIM}${S.BOX_V}${RESET}   ${pad(line, inner - 3)}${ACCENT_DIM}${S.BOX_V}${RESET}`);
  }
  console.log(`  ${ACCENT_DIM}${S.BOX_V}${RESET}${' '.repeat(inner)}${ACCENT_DIM}${S.BOX_V}${RESET}`);
  console.log(`  ${ACCENT_DIM}${S.BOX_V}${RESET}   ${pad(subtitle, inner - 3)}${ACCENT_DIM}${S.BOX_V}${RESET}`);
  console.log(`  ${ACCENT_DIM}${S.BOX_V}${RESET}${' '.repeat(inner)}${ACCENT_DIM}${S.BOX_V}${RESET}`);
  console.log(`  ${ACCENT_DIM}${S.BOX_BL}${S.BOX_H.repeat(inner)}${S.BOX_BR}${RESET}`);
  console.log('');
}

function printNote(title: string, body: string, color: string = ACCENT_DIM): void {
  const w = getPreferredMenuWidth() - 8;
  const innerW = w - 4;
  const titleLine = ` ${title} `;
  const titleLen = stripAnsi(titleLine).length;
  const dashesAfter = Math.max(0, w - 2 - titleLen);

  console.log(`${ACCENT_DIM}${S.BAR}${RESET}`);
  console.log(`${ACCENT_DIM}${S.BAR}${RESET}  ${color}${S.BOX_TL}${S.BOX_H}${RESET} ${ACCENT}${title}${RESET} ${color}${S.BOX_H.repeat(dashesAfter)}${S.BOX_TR}${RESET}`);

  const bodyLines = wordWrap(body, innerW);
  for (const line of bodyLines) {
    const padded = line + ' '.repeat(Math.max(0, innerW - stripAnsi(line).length));
    console.log(`${ACCENT_DIM}${S.BAR}${RESET}  ${color}${S.BOX_V}${RESET}  ${padded}  ${color}${S.BOX_V}${RESET}`);
  }

  console.log(`${ACCENT_DIM}${S.BAR}${RESET}  ${color}${S.BOX_BL}${S.BOX_H.repeat(w)}${S.BOX_BR}${RESET}`);
  console.log(`${ACCENT_DIM}${S.BAR}${RESET}`);
}

function printSummaryTable(rows: Array<[string, string]>): void {
  const w = getPreferredMenuWidth() - 8;
  const innerW = w - 4;
  const labelWidth = Math.max(...rows.map(([l]) => l.length)) + 2;

  const titleText = 'Configuration Summary';
  const dashesAfter = Math.max(0, w - 2 - titleText.length - 2);

  console.log(`${ACCENT_DIM}${S.BAR}${RESET}`);
  console.log(`${ACCENT_DIM}${S.BAR}${RESET}  ${ACCENT_DIM}${S.BOX_TL}${S.BOX_H}${RESET} ${ACCENT}${titleText}${RESET} ${ACCENT_DIM}${S.BOX_H.repeat(dashesAfter)}${S.BOX_TR}${RESET}`);
  console.log(`${ACCENT_DIM}${S.BAR}${RESET}  ${ACCENT_DIM}${S.BOX_V}${RESET}${' '.repeat(innerW + 2)}  ${ACCENT_DIM}${S.BOX_V}${RESET}`);

  for (const [label, value] of rows) {
    const paddedLabel = label + ' '.repeat(Math.max(0, labelWidth - label.length));
    const valStr = `${BOLD}${value}${RESET}`;
    const lineText = `${MUTED}${paddedLabel}${RESET}${valStr}`;
    const visLen = paddedLabel.length + stripAnsi(value).length;
    const rightPad = ' '.repeat(Math.max(0, innerW - visLen));
    console.log(`${ACCENT_DIM}${S.BAR}${RESET}  ${ACCENT_DIM}${S.BOX_V}${RESET}  ${lineText}${rightPad}  ${ACCENT_DIM}${S.BOX_V}${RESET}`);
  }

  console.log(`${ACCENT_DIM}${S.BAR}${RESET}  ${ACCENT_DIM}${S.BOX_V}${RESET}${' '.repeat(innerW + 2)}  ${ACCENT_DIM}${S.BOX_V}${RESET}`);
  console.log(`${ACCENT_DIM}${S.BAR}${RESET}  ${ACCENT_DIM}${S.BOX_BL}${S.BOX_H.repeat(w)}${S.BOX_BR}${RESET}`);
  console.log(`${ACCENT_DIM}${S.BAR}${RESET}`);
}

function printOutro(nextSteps: Array<[string, string]>): void {
  const w = getPreferredMenuWidth() - 8;
  const innerW = w - 4;

  console.log(`${ACCENT_DIM}${S.BAR}${RESET}`);
  console.log(`${SUCCESS}${S.STEP_DONE}${RESET}  ${BOLD}Setup complete!${RESET}`);
  console.log(`${ACCENT_DIM}${S.BAR}${RESET}`);

  const titleText = 'Next Steps';
  const dashesAfter = Math.max(0, w - 2 - titleText.length - 2);

  console.log(`${ACCENT_DIM}${S.BAR}${RESET}  ${ACCENT_DIM}${S.BOX_TL}${S.BOX_H}${RESET} ${ACCENT}${titleText}${RESET} ${ACCENT_DIM}${S.BOX_H.repeat(dashesAfter)}${S.BOX_TR}${RESET}`);
  console.log(`${ACCENT_DIM}${S.BAR}${RESET}  ${ACCENT_DIM}${S.BOX_V}${RESET}${' '.repeat(innerW + 2)}  ${ACCENT_DIM}${S.BOX_V}${RESET}`);

  const cmdWidth = Math.max(...nextSteps.map(([c]) => c.length)) + 2;
  for (const [cmd, desc] of nextSteps) {
    const paddedCmd = cmd + ' '.repeat(Math.max(0, cmdWidth - cmd.length));
    const lineText = `${ACCENT}${S.BULLET}${RESET} ${BOLD}${paddedCmd}${RESET}${MUTED}${desc}${RESET}`;
    const visLen = 2 + paddedCmd.length + desc.length;
    const rightPad = ' '.repeat(Math.max(0, innerW - visLen));
    console.log(`${ACCENT_DIM}${S.BAR}${RESET}  ${ACCENT_DIM}${S.BOX_V}${RESET}  ${lineText}${rightPad}  ${ACCENT_DIM}${S.BOX_V}${RESET}`);
  }

  console.log(`${ACCENT_DIM}${S.BAR}${RESET}  ${ACCENT_DIM}${S.BOX_V}${RESET}${' '.repeat(innerW + 2)}  ${ACCENT_DIM}${S.BOX_V}${RESET}`);
  console.log(`${ACCENT_DIM}${S.BAR}${RESET}  ${ACCENT_DIM}${S.BOX_BL}${S.BOX_H.repeat(w)}${S.BOX_BR}${RESET}`);
  console.log(`${ACCENT_DIM}${S.BAR}${RESET}`);
  console.log(`${ACCENT_DIM}${S.BAR_END}${RESET}  ${MUTED}Thanks for setting up Keygate!${RESET}`);
  console.log('');
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function wordWrap(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length === 0) {
      lines.push('');
      continue;
    }
    const words = paragraph.split(' ');
    let current = '';
    for (const word of words) {
      if (current.length === 0) {
        current = word;
      } else if (current.length + 1 + word.length <= maxWidth) {
        current += ` ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current.length > 0) {
      lines.push(current);
    }
  }
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
