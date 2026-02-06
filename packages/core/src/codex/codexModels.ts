import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { CodexModelEntry } from './types.js';
import type { CodexReasoningEffort } from '../types.js';

export const CODEX_PROVIDER_ID = 'openai-codex';
const CODEX_MODEL_CACHE_FILE = 'codex-models-cache.json';
const DEFAULT_REASONING_EFFORT: CodexReasoningEffort = 'medium';

export const CODEX_REASONING_EFFORTS: readonly CodexReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
];

const SUPPORTED_CODEX_MODEL_IDS = new Set<string>([
  'gpt-5.3-codex',
  'gpt-5.2-codex',
]);

export interface CodexModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  supportsPersonality: boolean;
  reasoningEffort: CodexReasoningEffort[];
  defaultReasoningEffort?: CodexReasoningEffort;
}

export interface ProviderModel {
  id: string;
  provider: typeof CODEX_PROVIDER_ID;
  codexModelId: string;
  displayName: string;
  isDefault: boolean;
  supportsPersonality: boolean;
  reasoningEffort: CodexReasoningEffort[];
  defaultReasoningEffort?: CodexReasoningEffort;
}

const FALLBACK_CODEX_MODELS: CodexModel[] = [
  {
    id: 'gpt-5.3-codex',
    displayName: 'GPT-5.3 Codex',
    isDefault: true,
    supportsPersonality: false,
    reasoningEffort: [...CODEX_REASONING_EFFORTS],
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
  },
  {
    id: 'gpt-5.2-codex',
    displayName: 'GPT-5.2 Codex',
    isDefault: false,
    supportsPersonality: false,
    reasoningEffort: [...CODEX_REASONING_EFFORTS],
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
  },
];

export function normalizeCodexModels(entries: CodexModelEntry[]): CodexModel[] {
  const discovered = new Map<string, CodexModel>();

  for (const entry of entries) {
    const id = entry.id ?? entry.model;
    const canonicalId = canonicalizeCodexModelId(id);

    if (!canonicalId) {
      continue;
    }

    discovered.set(canonicalId, {
      id: canonicalId,
      displayName: entry.displayName ?? fallbackDisplayNameFor(canonicalId),
      isDefault: entry.isDefault ?? false,
      supportsPersonality: entry.supportsPersonality ?? false,
      reasoningEffort: [...CODEX_REASONING_EFFORTS],
      defaultReasoningEffort: normalizeReasoningEffort(entry.defaultReasoningEffort) ?? DEFAULT_REASONING_EFFORT,
    });
  }

  return mergeWithSupportedFallback(discovered);
}

export function codexModelIdToShortName(modelId: string): string {
  if (modelId.endsWith('-codex')) {
    return modelId.slice(0, -'-codex'.length);
  }

  return modelId;
}

export function providerModelIdFromCodexModelId(modelId: string): string {
  return `${CODEX_PROVIDER_ID}/${codexModelIdToShortName(modelId)}`;
}

export function codexModelFromProviderModelId(
  providerModelId: string,
  availableModels: CodexModel[] = FALLBACK_CODEX_MODELS
): string {
  const available = availableModels.length > 0 ? availableModels : getFallbackCodexModels();
  const fallbackModel = pickDefaultCodexModel(available).id;

  if (!providerModelId) {
    return fallbackModel;
  }

  const trimmed = providerModelId.trim();

  if (trimmed.startsWith(`${CODEX_PROVIDER_ID}/`)) {
    const shortName = trimmed.slice(`${CODEX_PROVIDER_ID}/`.length);

    const byShortName = available.find(
      (model) => codexModelIdToShortName(model.id) === shortName || model.id === shortName
    );

    if (byShortName) {
      return byShortName.id;
    }

    const canonical = canonicalizeCodexModelId(shortName);
    if (canonical && available.some((model) => model.id === canonical)) {
      return canonical;
    }

    return fallbackModel;
  }

  const canonical = canonicalizeCodexModelId(trimmed);
  if (canonical && available.some((model) => model.id === canonical)) {
    return canonical;
  }

  const byId = available.find((model) => model.id === trimmed);
  if (byId) {
    return byId.id;
  }

  return fallbackModel;
}

export function mapCodexModelsToProviderModels(models: CodexModel[]): ProviderModel[] {
  return models.map((model) => ({
    id: providerModelIdFromCodexModelId(model.id),
    provider: CODEX_PROVIDER_ID,
    codexModelId: model.id,
    displayName: model.displayName,
    isDefault: model.isDefault,
    supportsPersonality: model.supportsPersonality,
    reasoningEffort: [...model.reasoningEffort],
    defaultReasoningEffort: model.defaultReasoningEffort,
  }));
}

export function pickDefaultCodexModel(models: CodexModel[]): CodexModel {
  if (models.length === 0) {
    return FALLBACK_CODEX_MODELS[0]!;
  }

  const explicitDefault = models.find((model) => model.isDefault);
  if (explicitDefault) {
    return explicitDefault;
  }

  const preferred = models.find((model) => model.id === 'gpt-5.3-codex');
  if (preferred) {
    return preferred;
  }

  return models[0]!;
}

export function getFallbackCodexModels(): CodexModel[] {
  return FALLBACK_CODEX_MODELS.map((model) => ({
    ...model,
    reasoningEffort: [...model.reasoningEffort],
  }));
}

export function getCodexModelCachePath(configDir?: string): string {
  const baseDir = configDir ?? path.join(os.homedir(), '.config', 'keygate');
  return path.join(baseDir, CODEX_MODEL_CACHE_FILE);
}

export async function writeCodexModelCache(models: CodexModel[], configDir?: string): Promise<void> {
  const cachePath = getCodexModelCachePath(configDir);

  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(models, null, 2), 'utf8');
}

export async function readCodexModelCache(configDir?: string): Promise<CodexModel[] | null> {
  const cachePath = getCodexModelCachePath(configDir);

  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      return null;
    }

    const parsedModels = new Map<string, CodexModel>();
    for (const value of parsed) {
      if (!value || typeof value !== 'object') {
        continue;
      }

      const row = value as Record<string, unknown>;
      if (typeof row['id'] !== 'string') {
        continue;
      }

      const canonicalId = canonicalizeCodexModelId(row['id']);
      if (!canonicalId) {
        continue;
      }

      parsedModels.set(canonicalId, {
        id: canonicalId,
        displayName: typeof row['displayName'] === 'string' ? row['displayName'] : fallbackDisplayNameFor(canonicalId),
        isDefault: Boolean(row['isDefault']),
        supportsPersonality: Boolean(row['supportsPersonality']),
        reasoningEffort: [...CODEX_REASONING_EFFORTS],
        defaultReasoningEffort: normalizeReasoningEffort(row['defaultReasoningEffort']) ?? DEFAULT_REASONING_EFFORT,
      });
    }

    return mergeWithSupportedFallback(parsedModels);
  } catch {
    return null;
  }
}

function mergeWithSupportedFallback(discovered: Map<string, CodexModel>): CodexModel[] {
  const merged = FALLBACK_CODEX_MODELS.map((fallbackModel) => {
    const found = discovered.get(fallbackModel.id);
    if (!found) {
      return {
        ...fallbackModel,
        reasoningEffort: [...fallbackModel.reasoningEffort],
      };
    }

    return {
      ...fallbackModel,
      ...found,
      reasoningEffort: [...CODEX_REASONING_EFFORTS],
      defaultReasoningEffort: found.defaultReasoningEffort ?? fallbackModel.defaultReasoningEffort,
    };
  });

  const explicitDefault = merged.find((model) => model.isDefault);
  const defaultId = explicitDefault?.id ?? FALLBACK_CODEX_MODELS[0]!.id;

  return merged.map((model) => ({
    ...model,
    isDefault: model.id === defaultId,
  }));
}

function canonicalizeCodexModelId(modelId: unknown): string | null {
  if (typeof modelId !== 'string') {
    return null;
  }

  const normalized = modelId.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const withSuffix = normalized.endsWith('-codex') ? normalized : `${normalized}-codex`;

  return SUPPORTED_CODEX_MODEL_IDS.has(withSuffix) ? withSuffix : null;
}

function normalizeReasoningEffort(value: unknown): CodexReasoningEffort | null {
  if (typeof value !== 'string') {
    return null;
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
      return null;
  }
}

function fallbackDisplayNameFor(modelId: string): string {
  const fallback = FALLBACK_CODEX_MODELS.find((model) => model.id === modelId);
  return fallback?.displayName ?? modelId;
}
