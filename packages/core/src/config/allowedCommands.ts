import path from 'node:path';
import { promises as fs } from 'node:fs';
import { getConfigDir } from './env.js';

const ALLOWED_COMMANDS_FILENAME = 'allowed_commands.json';
const MAX_WRAPPER_UNWRAP_DEPTH = 4;
const GLOBAL_AUTO_APPROVAL_BLOCKLIST = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'ksh',
  'dash',
  'pwsh',
  'powershell',
  'cmd',
  'python',
  'python3',
  'node',
  'deno',
  'ruby',
  'perl',
  'php',
  'lua',
]);
const SHELL_WRAPPER_BINARIES = new Set(['bash', 'sh', 'zsh', 'fish', 'ksh', 'dash']);

export interface AllowedCommandsRegistry {
  version: 1;
  commands: string[];
}

function getRegistryPath(): string {
  return path.join(getConfigDir(), ALLOWED_COMMANDS_FILENAME);
}

export async function loadAllowedCommands(): Promise<AllowedCommandsRegistry> {
  const registryPath = getRegistryPath();
  try {
    const raw = await fs.readFile(registryPath, 'utf8');
    const parsed = JSON.parse(raw) as AllowedCommandsRegistry;
    if (parsed && typeof parsed === 'object' && parsed.version === 1 && Array.isArray(parsed.commands)) {
      const sanitized = sanitizeCommands(parsed.commands);
      if (!areCommandsEqual(parsed.commands, sanitized)) {
        const normalizedRegistry: AllowedCommandsRegistry = {
          version: 1,
          commands: sanitized,
        };
        await saveAllowedCommands(normalizedRegistry);
        return normalizedRegistry;
      }

      return {
        version: 1,
        commands: sanitized,
      };
    }
    return createEmptyRegistry();
  } catch {
    return createEmptyRegistry();
  }
}

export async function saveAllowedCommands(registry: AllowedCommandsRegistry): Promise<void> {
  const registryPath = getRegistryPath();
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

function createEmptyRegistry(): AllowedCommandsRegistry {
  return { version: 1, commands: [] };
}

export async function getAllowedCommandsSet(): Promise<Set<string>> {
  const registry = await loadAllowedCommands();
  return new Set(registry.commands);
}

export async function addAllowedCommand(baseCommand: string): Promise<void> {
  const normalized = normalizeBaseCommand(baseCommand);
  if (!normalized || !isGlobalAutoApprovalEligible(normalized)) {
    return; // Don't allow empty commands
  }

  const registry = await loadAllowedCommands();
  if (!registry.commands.includes(normalized)) {
    registry.commands.push(normalized);
    registry.commands.sort(); // Keep the file reasonably ordered
    await saveAllowedCommands(registry);
  }
}

/**
 * Extracts the base command (binary/executable) from a full shell command string.
 * Example: 'npm install --save foo' -> 'npm'
 * Example: 'git commit -m "update"' -> 'git'
 * Example: './script.sh --flag' -> './script.sh'
 */
export function extractBaseCommand(fullCommand: string): string {
  return extractBaseCommandInternal(fullCommand, 0);
}

export function extractBaseCommandFromCommandValue(command: unknown): string {
  if (Array.isArray(command)) {
    const fromArgs = extractBaseCommandFromArgs(command, 0);
    if (fromArgs) {
      return fromArgs;
    }
  }

  if (typeof command === 'string') {
    return extractBaseCommand(command);
  }

  return '';
}

function extractBaseCommandInternal(fullCommand: string, depth: number): string {
  const trimmed = fullCommand.trim();
  if (!trimmed) {
    return '';
  }

  const words = splitCommandWords(trimmed);
  if (words.length === 0) {
    return '';
  }

  for (let index = 0; index < words.length; index += 1) {
    const token = stripOuterQuotes(words[index] ?? '').trim();
    if (!token) {
      continue;
    }

    if (looksLikeEnvAssignment(token)) {
      continue;
    }

    if (normalizeBaseCommand(token) === 'env') {
      continue;
    }

    const unwrapped = extractWrappedInnerBaseCommand(words, index, depth);
    if (unwrapped) {
      return unwrapped;
    }

    return token;
  }

  // Backup fallback
  const firstSpace = trimmed.indexOf(' ');
  return firstSpace > 0 ? trimmed.substring(0, firstSpace) : trimmed;
}

function extractBaseCommandFromArgs(args: unknown[], depth: number): string {
  if (depth >= MAX_WRAPPER_UNWRAP_DEPTH) {
    return '';
  }

  const tokens = args
    .filter((part): part is string => typeof part === 'string')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (tokens.length === 0) {
    return '';
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = stripOuterQuotes(tokens[index] ?? '').trim();
    if (!token) {
      continue;
    }

    if (looksLikeEnvAssignment(token)) {
      continue;
    }

    if (normalizeBaseCommand(token) === 'env') {
      continue;
    }

    const nested = extractWrappedInnerBaseCommandFromArgs(tokens, index, depth);
    if (nested) {
      return nested;
    }

    return token;
  }

  return '';
}

function extractWrappedInnerBaseCommandFromArgs(
  args: string[],
  executableIndex: number,
  depth: number
): string | null {
  if (depth >= MAX_WRAPPER_UNWRAP_DEPTH) {
    return null;
  }

  const executable = stripOuterQuotes(args[executableIndex] ?? '').trim();
  const normalizedExecutable = normalizeBaseCommand(executable);
  if (!normalizedExecutable || !GLOBAL_AUTO_APPROVAL_BLOCKLIST.has(normalizedExecutable)) {
    return null;
  }

  const innerCommandStart = findInnerCommandStart(args, executableIndex + 1, normalizedExecutable);
  if (innerCommandStart < 0 || innerCommandStart >= args.length) {
    return null;
  }

  const innerCommand = normalizedExecutable === 'cmd'
    ? args.slice(innerCommandStart).map((part) => stripOuterQuotes(part)).join(' ')
    : stripOuterQuotes(args[innerCommandStart] ?? '');
  if (!innerCommand.trim()) {
    return null;
  }

  const nestedFromArgs = extractBaseCommandFromArgs([innerCommand], depth + 1);
  if (nestedFromArgs.trim().length > 0) {
    return nestedFromArgs;
  }

  const nested = extractBaseCommandInternal(innerCommand, depth + 1);
  return nested.trim().length > 0 ? nested : null;
}

function extractWrappedInnerBaseCommand(
  words: string[],
  executableIndex: number,
  depth: number
): string | null {
  if (depth >= MAX_WRAPPER_UNWRAP_DEPTH) {
    return null;
  }

  const executable = stripOuterQuotes(words[executableIndex] ?? '').trim();
  const normalizedExecutable = normalizeBaseCommand(executable);
  if (!normalizedExecutable || !GLOBAL_AUTO_APPROVAL_BLOCKLIST.has(normalizedExecutable)) {
    return null;
  }

  const innerCommandStart = findInnerCommandStart(words, executableIndex + 1, normalizedExecutable);
  if (innerCommandStart < 0 || innerCommandStart >= words.length) {
    return null;
  }

  const innerCommand = words
    .slice(innerCommandStart)
    .map((part) => stripOuterQuotes(part))
    .join(' ')
    .trim();
  if (!innerCommand) {
    return null;
  }

  const nested = extractBaseCommandInternal(innerCommand, depth + 1);
  return nested.trim().length > 0 ? nested : null;
}

function findInnerCommandStart(words: string[], startIndex: number, wrapper: string): number {
  if (wrapper === 'cmd') {
    for (let i = startIndex; i < words.length; i += 1) {
      const token = stripOuterQuotes(words[i] ?? '').trim().toLowerCase();
      if (token === '/c' || token === '/k') {
        return i + 1;
      }
    }
    return -1;
  }

  const commandFlags = getWrapperCommandFlags(wrapper);
  if (commandFlags.length === 0) {
    return -1;
  }

  for (let i = startIndex; i < words.length; i += 1) {
    const token = stripOuterQuotes(words[i] ?? '').trim().toLowerCase();
    if (commandFlags.includes(token)) {
      return i + 1;
    }
  }

  return -1;
}

function getWrapperCommandFlags(wrapper: string): string[] {
  if (SHELL_WRAPPER_BINARIES.has(wrapper)) {
    return ['-c', '-lc'];
  }

  switch (wrapper) {
    case 'pwsh':
    case 'powershell':
      return ['-command', '-c'];
    case 'python':
    case 'python3':
      return ['-c'];
    case 'node':
    case 'deno':
      return ['-e'];
    case 'ruby':
    case 'perl':
    case 'php':
    case 'lua':
      return ['-e'];
    default:
      return [];
  }
}

function splitCommandWords(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}

function stripOuterQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith('\'') && value.endsWith('\''))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function looksLikeEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

export function normalizeBaseCommand(baseCommand: string): string {
  const trimmed = baseCommand.trim();
  if (!trimmed) {
    return '';
  }

  const firstToken = splitCommandWords(trimmed)[0] ?? trimmed;
  const withoutQuotes = stripOuterQuotes(firstToken).replace(/^['"]|['"]$/g, '');
  const basename = path.basename(withoutQuotes).toLowerCase();
  if (basename.endsWith('.exe')) {
    return basename.slice(0, -4);
  }

  return basename;
}

export function isGlobalAutoApprovalEligible(baseCommand: string): boolean {
  const normalized = normalizeBaseCommand(baseCommand);
  if (!normalized) {
    return false;
  }

  return !GLOBAL_AUTO_APPROVAL_BLOCKLIST.has(normalized);
}

function sanitizeCommands(commands: string[]): string[] {
  const unique = new Set<string>();
  for (const command of commands) {
    const normalized = normalizeBaseCommand(command);
    if (!normalized || !isGlobalAutoApprovalEligible(normalized)) {
      continue;
    }
    unique.add(normalized);
  }

  return Array.from(unique).sort();
}

function areCommandsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}
