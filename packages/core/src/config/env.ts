import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import dotenv from 'dotenv';
import type { CodexReasoningEffort, KeygateConfig } from '../types.js';

const DEFAULT_ALLOWED_BINARIES = ['git', 'ls', 'npm', 'cat', 'node', 'python3'];

export function getConfigDir(): string {
  return path.join(os.homedir(), '.config', 'keygate');
}

export function getEnvFilePath(): string {
  return path.join(getConfigDir(), '.env');
}

export function loadEnvironment(): void {
  dotenv.config({ path: getEnvFilePath() });
  dotenv.config();
}

export function loadConfigFromEnv(): KeygateConfig {
  const provider = normalizeProvider(process.env['LLM_PROVIDER']);

  return {
    llm: {
      provider,
      model: process.env['LLM_MODEL'] ?? getDefaultModelForProvider(provider),
      reasoningEffort:
        normalizeCodexReasoningEffort(process.env['LLM_REASONING_EFFORT']) ??
        (provider === 'openai-codex' ? 'medium' : undefined),
      apiKey: process.env['LLM_API_KEY'] ?? '',
      ollama: {
        host: process.env['LLM_OLLAMA_HOST'] ?? 'http://127.0.0.1:11434',
      },
    },
    security: {
      mode: 'safe',
      spicyModeEnabled: process.env['SPICY_MODE_ENABLED'] === 'true',
      workspacePath: process.env['WORKSPACE_PATH'] ?? '~/keygate-workspace',
      allowedBinaries: DEFAULT_ALLOWED_BINARIES,
    },
    server: {
      port: parseInt(process.env['PORT'] ?? '18790', 10),
    },
  };
}

export async function updateEnvFile(updates: Record<string, string>): Promise<void> {
  const envPath = getEnvFilePath();

  await fs.mkdir(path.dirname(envPath), { recursive: true });

  let content = '';
  try {
    content = await fs.readFile(envPath, 'utf8');
  } catch {
    content = '';
  }

  const lines = content.length > 0 ? content.split(/\r?\n/g) : [];
  const seen = new Set<string>();

  const updatedLines = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      return line;
    }

    const key = match[1]!;
    if (!Object.prototype.hasOwnProperty.call(updates, key)) {
      return line;
    }

    seen.add(key);
    return `${key}=${serializeEnvValue(updates[key]!)}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (seen.has(key)) {
      continue;
    }
    updatedLines.push(`${key}=${serializeEnvValue(value)}`);
  }

  const normalized = updatedLines
    .map((line) => line.trimEnd())
    .filter((line, index, array) => !(index === array.length - 1 && line === ''))
    .join('\n');

  await fs.writeFile(envPath, `${normalized}\n`, 'utf8');
}

function normalizeProvider(value: string | undefined): KeygateConfig['llm']['provider'] {
  switch (value) {
    case 'openai':
    case 'gemini':
    case 'ollama':
    case 'openai-codex':
      return value;
    default:
      return 'openai';
  }
}

function normalizeCodexReasoningEffort(value: string | undefined): CodexReasoningEffort | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  switch (normalized) {
    case 'low':
    case 'medium':
    case 'high':
      return normalized;
    case 'xhigh':
    case 'extra-high':
    case 'extra_high':
    case 'extra high':
      return 'xhigh';
    default:
      return undefined;
  }
}

export function getDefaultModelForProvider(provider: KeygateConfig['llm']['provider']): string {
  switch (provider) {
    case 'openai':
      return 'gpt-4o';
    case 'gemini':
      return 'gemini-1.5-pro';
    case 'ollama':
      return 'llama3';
    case 'openai-codex':
      return 'openai-codex/gpt-5.3';
    default:
      return 'gpt-4o';
  }
}

function serializeEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:\-]*$/.test(value)) {
    return value;
  }

  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');

  return `"${escaped}"`;
}
