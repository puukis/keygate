import type { Api } from 'grammy';

const KEYGATE_COMMANDS = [
  { command: 'help', description: 'Show available Keygate operator commands.' },
  { command: 'status', description: 'Show current model, tokens, and runtime health.' },
  { command: 'model', description: 'Show or update the session model override.' },
  { command: 'compact', description: 'Summarize the session and keep a short recent tail.' },
  { command: 'debug', description: 'Show or toggle the session debug buffer.' },
  { command: 'stop', description: 'Cancel the active run for this session.' },
  { command: 'new', description: 'Start a fresh session.' },
  { command: 'reset', description: 'Reset the session history and local overrides.' },
  { command: 'inspect', description: 'Show session diagnostics (session key, pairing status).' },
];

/**
 * Register Keygate operator commands with the Telegram bot menu.
 */
export async function registerBotCommands(api: Api): Promise<void> {
  try {
    await api.setMyCommands(KEYGATE_COMMANDS);
  } catch (error) {
    console.warn('Failed to register Telegram bot commands:', error);
  }
}

/**
 * Parse a Telegram message into a gateway slash command string.
 * Returns the command string (e.g. "/status") or null if not a slash command.
 */
export function parseTelegramCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  // Strip @BotUsername suffix if present (e.g. /status@MyBot -> /status)
  const withoutBot = trimmed.replace(/@\w+/, '');

  // Map known commands to their gateway equivalents
  const spaceIdx = withoutBot.indexOf(' ');
  const commandName = spaceIdx === -1 ? withoutBot.slice(1) : withoutBot.slice(1, spaceIdx);
  const args = spaceIdx === -1 ? '' : withoutBot.slice(spaceIdx + 1).trim();

  switch (commandName) {
    case 'help':
    case 'status':
    case 'compact':
    case 'stop':
    case 'new':
    case 'reset':
    case 'inspect':
      return `/${commandName}`;
    case 'debug':
      return args ? `/debug ${args}` : '/debug';
    case 'model':
      return args ? `/model ${args}` : '/model';
    default:
      return null;
  }
}
