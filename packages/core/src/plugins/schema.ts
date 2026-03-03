import { promises as fs } from 'node:fs';
import Ajv from 'ajv';
import type { PluginConfigValidationResult, ResolvedPluginManifest } from './types.js';

const ajv = new Ajv({
  allErrors: true,
  strict: false,
});

const validatorCache = new Map<string, ReturnType<typeof ajv.compile>>();

export async function loadPluginConfigSchema(
  manifest: Pick<ResolvedPluginManifest, 'configSchemaPath'>
): Promise<Record<string, unknown> | null> {
  if (!manifest.configSchemaPath) {
    return null;
  }

  const raw = await fs.readFile(manifest.configSchemaPath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Plugin config schema must be a JSON object.');
  }
  return parsed;
}

export async function validatePluginConfig(
  manifest: Pick<ResolvedPluginManifest, 'configSchemaPath'>,
  config: Record<string, unknown>
): Promise<PluginConfigValidationResult> {
  const schema = await loadPluginConfigSchema(manifest);
  if (!schema) {
    return {
      valid: true,
      issues: [],
      schema: null,
    };
  }

  const cacheKey = manifest.configSchemaPath!;
  let validator = validatorCache.get(cacheKey);
  if (!validator) {
    validator = ajv.compile(schema);
    validatorCache.set(cacheKey, validator);
  }

  const valid = validator(config);
  if (valid) {
    return {
      valid: true,
      issues: [],
      schema,
    };
  }

  return {
    valid: false,
    issues: (validator.errors ?? []).map((error) => ({
      path: formatInstancePath(error.instancePath),
      message: error.message ?? 'Validation failed.',
    })),
    schema,
  };
}

export function clearPluginSchemaCache(): void {
  validatorCache.clear();
}

function formatInstancePath(instancePath: string): string {
  if (!instancePath) {
    return '$';
  }

  return `$${instancePath.replace(/\//g, '.')}`;
}
