import path from 'node:path';
import { promises as fs } from 'node:fs';
import { getConfigDir } from './env.js';

const ALLOWED_COMMANDS_FILENAME = 'allowed_commands.json';

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
      return parsed;
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
  const normalized = baseCommand.trim();
  if (!normalized) {
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
  const trimmed = fullCommand.trim();
  if (!trimmed) {
    return '';
  }

  // Handle environment variables at the start (e.g., `FOO=bar npm start`)
  const words = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  
  for (const word of words) {
    // Skip words that look like environment variable assignments at the beginning
    if (word.includes('=') && !word.startsWith('-')) {
      continue;
    }
    
    // The first non-env-var word is our base executable
    return word;
  }

  // Backup fallback
  const firstSpace = trimmed.indexOf(' ');
  return firstSpace > 0 ? trimmed.substring(0, firstSpace) : trimmed;
}
