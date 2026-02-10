import path from 'node:path';
import { statSync } from 'node:fs';
import type { KeygateConfig, SkillDefinition, SkillEntryConfig } from '../types.js';
import type { SkillEligibilityContext, SkillEligibilityResult } from './types.js';

export function evaluateSkillEligibility(
  skill: SkillDefinition,
  context: SkillEligibilityContext
): SkillEligibilityResult {
  const entryKey = getSkillEntryKey(skill);
  const entry = context.config.skills?.entries?.[entryKey];
  const envOverlay = buildEntryEnvOverlay(skill, entry);

  if (entry?.enabled === false) {
    return {
      eligible: false,
      reason: 'disabled',
      envOverlay,
      entryConfig: entry,
    };
  }

  const allowBundled = context.config.skills?.allowBundled;
  if (
    skill.sourceType === 'bundled' &&
    Array.isArray(allowBundled) &&
    allowBundled.length > 0 &&
    !allowBundled.includes(skill.name)
  ) {
    return {
      eligible: false,
      reason: 'bundled_not_allowed',
      envOverlay,
      entryConfig: entry,
    };
  }

  const metadata = skill.metadata;
  if (!metadata) {
    return {
      eligible: true,
      reason: 'eligible',
      envOverlay,
      entryConfig: entry,
    };
  }

  if (metadata.always === true) {
    return {
      eligible: true,
      reason: 'eligible',
      envOverlay,
      entryConfig: entry,
    };
  }

  if (
    Array.isArray(metadata.os) &&
    metadata.os.length > 0 &&
    !metadata.os.some((platformName) => platformName === process.platform)
  ) {
    return {
      eligible: false,
      reason: 'os_mismatch',
      envOverlay,
      entryConfig: entry,
    };
  }

  const requires = metadata.requires;
  if (requires) {
    if (Array.isArray(requires.bins) && requires.bins.length > 0) {
      const hasAllBins = requires.bins.every((bin) => hasBinary(bin));
      if (!hasAllBins) {
        return {
          eligible: false,
          reason: 'missing_bins',
          envOverlay,
          entryConfig: entry,
        };
      }
    }

    if (Array.isArray(requires.anyBins) && requires.anyBins.length > 0) {
      const hasAnyBin = requires.anyBins.some((bin) => hasBinary(bin));
      if (!hasAnyBin) {
        return {
          eligible: false,
          reason: 'missing_any_bins',
          envOverlay,
          entryConfig: entry,
        };
      }
    }

    if (Array.isArray(requires.env) && requires.env.length > 0) {
      const hasAllEnv = requires.env.every((envName) => hasEnvValue(envName, envOverlay));
      if (!hasAllEnv) {
        return {
          eligible: false,
          reason: 'missing_env',
          envOverlay,
          entryConfig: entry,
        };
      }
    }

    if (Array.isArray(requires.config) && requires.config.length > 0) {
      const hasAllConfigPaths = requires.config.every((configPath) => isTruthyPath(context.allConfig, configPath));
      if (!hasAllConfigPaths) {
        return {
          eligible: false,
          reason: 'missing_config',
          envOverlay,
          entryConfig: entry,
        };
      }
    }
  }

  return {
    eligible: true,
    reason: 'eligible',
    envOverlay,
    entryConfig: entry,
  };
}

export function getSkillEntryKey(skill: SkillDefinition): string {
  const configured = skill.metadata?.skillKey;
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured.trim();
  }

  return skill.name;
}

export function buildEntryEnvOverlay(skill: SkillDefinition, entry: SkillEntryConfig | undefined): Record<string, string> {
  const overlay: Record<string, string> = {};

  if (!entry) {
    return overlay;
  }

  const entryEnv = entry.env;
  if (entryEnv && typeof entryEnv === 'object') {
    for (const [key, value] of Object.entries(entryEnv)) {
      if (typeof value !== 'string') {
        continue;
      }

      if (typeof process.env[key] === 'string' && process.env[key]!.length > 0) {
        continue;
      }

      overlay[key] = value;
    }
  }

  const primaryEnv = skill.metadata?.primaryEnv;
  if (
    primaryEnv &&
    typeof entry.apiKey === 'string' &&
    entry.apiKey.length > 0 &&
    !(typeof process.env[primaryEnv] === 'string' && process.env[primaryEnv]!.length > 0) &&
    !(primaryEnv in overlay)
  ) {
    overlay[primaryEnv] = entry.apiKey;
  }

  return overlay;
}

function hasEnvValue(name: string, overlay: Record<string, string>): boolean {
  const processValue = process.env[name];
  if (typeof processValue === 'string' && processValue.length > 0) {
    return true;
  }

  const overlayValue = overlay[name];
  return typeof overlayValue === 'string' && overlayValue.length > 0;
}


function hasBinary(binary: string): boolean {
  const target = binary.trim();
  if (!target) {
    return false;
  }

  const envPath = process.env['PATH'] ?? '';
  const pathEntries = envPath.split(path.delimiter).filter((entry) => entry.length > 0);

  const executableNames = process.platform === 'win32'
    ? buildWindowsExecutableNames(target)
    : [target];

  for (const dir of pathEntries) {
    for (const executableName of executableNames) {
      const candidate = path.join(dir, executableName);
      try {
        const stat = requireStat(candidate);
        if (stat.isFile()) {
          return true;
        }
      } catch {
        // Continue scanning.
      }
    }
  }

  return false;
}

function buildWindowsExecutableNames(binary: string): string[] {
  const ext = path.extname(binary);
  if (ext) {
    return [binary];
  }

  const pathExt = (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return [binary, ...pathExt.map((suffix) => `${binary}${suffix.toLowerCase()}`)];
}

function requireStat(filePath: string) {
  return statSync(filePath);
}

function isTruthyPath(root: Record<string, unknown>, dottedPath: string): boolean {
  const segments = dottedPath.split('.').map((entry) => entry.trim()).filter(Boolean);
  if (segments.length === 0) {
    return false;
  }

  let current: unknown = root;
  for (const segment of segments) {
    if (!current || typeof current !== 'object') {
      return false;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return Boolean(current);
}

export function buildEligibilityContext(config: KeygateConfig): SkillEligibilityContext {
  return {
    config,
    allConfig: config as unknown as Record<string, unknown>,
  };
}
