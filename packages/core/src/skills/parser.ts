import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { SkillDefinition, SkillFrontmatter, SkillMetadataKeygate, SkillSourceType } from '../types.js';
import type { SkillParseResult } from './types.js';

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const ALLOWED_KEYS = new Set([
  'name',
  'description',
  'homepage',
  'user-invocable',
  'disable-model-invocation',
  'command-dispatch',
  'command-tool',
  'command-arg-mode',
  'metadata',
]);

export async function parseSkillAtPath(
  skillDir: string,
  sourceType: SkillSourceType
): Promise<SkillParseResult> {
  const skillFile = path.join(skillDir, 'SKILL.md');

  let raw: string;
  try {
    raw = await fs.readFile(skillFile, 'utf8');
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read ${skillFile}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const parsed = parseSkillMarkdown(raw);
  if (!parsed.ok) {
    return parsed;
  }

  const folderName = path.basename(skillDir);
  if (folderName !== parsed.value.name) {
    return {
      ok: false,
      error: `Skill folder name "${folderName}" must match skill name "${parsed.value.name}"`,
    };
  }

  return {
    ok: true,
    value: {
      ...parsed.value,
      location: skillDir,
      sourceType,
    },
  };
}

export function parseSkillMarkdown(markdown: string): SkillParseResult {
  const frontmatter = extractFrontmatter(markdown);
  if (!frontmatter.ok) {
    return frontmatter;
  }

  const mapped = mapFrontmatter(frontmatter.value.frontmatter, frontmatter.value.body);
  if (!mapped.ok) {
    return mapped;
  }

  return {
    ok: true,
    value: mapped.value,
  };
}

function extractFrontmatter(markdown: string):
  | { ok: true; value: { frontmatter: Record<string, string | boolean>; body: string } }
  | { ok: false; error: string } {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  if (lines[0]?.trim() !== '---') {
    return {
      ok: false,
      error: 'SKILL.md must start with YAML frontmatter (---)',
    };
  }

  let endIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '---') {
      endIndex = index;
      break;
    }
  }

  if (endIndex < 0) {
    return {
      ok: false,
      error: 'Missing closing YAML frontmatter delimiter (---)',
    };
  }

  const frontmatterLines = lines.slice(1, endIndex);
  const body = lines.slice(endIndex + 1).join('\n').trim();

  const frontmatter: Record<string, string | boolean> = {};
  for (const rawLine of frontmatterLines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const separator = line.indexOf(':');
    if (separator <= 0) {
      return {
        ok: false,
        error: `Invalid frontmatter line: "${rawLine}"`,
      };
    }

    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();

    if (!ALLOWED_KEYS.has(key)) {
      return {
        ok: false,
        error: `Unsupported frontmatter key "${key}"`,
      };
    }

    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      return {
        ok: false,
        error: `Duplicate frontmatter key "${key}"`,
      };
    }

    const parsedValue = parseFrontmatterValue(rawValue);
    frontmatter[key] = parsedValue;
  }

  return {
    ok: true,
    value: {
      frontmatter,
      body,
    },
  };
}

function parseFrontmatterValue(rawValue: string): string | boolean {
  const trimmed = rawValue.trim();

  if (trimmed === 'true') {
    return true;
  }

  if (trimmed === 'false') {
    return false;
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function mapFrontmatter(
  frontmatter: Record<string, string | boolean>,
  body: string
): SkillParseResult {
  const name = frontmatter['name'];
  const description = frontmatter['description'];

  if (typeof name !== 'string' || name.trim().length === 0) {
    return {
      ok: false,
      error: 'Skill frontmatter requires a non-empty "name"',
    };
  }

  if (!SKILL_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      error: `Skill name "${name}" must match ${SKILL_NAME_PATTERN.source}`,
    };
  }

  if (typeof description !== 'string' || description.trim().length === 0) {
    return {
      ok: false,
      error: 'Skill frontmatter requires a non-empty "description"',
    };
  }

  const parsed: SkillFrontmatter = {
    name,
    description,
  };

  const homepage = frontmatter['homepage'];
  if (typeof homepage === 'string' && homepage.trim().length > 0) {
    parsed.homepage = homepage.trim();
  }

  const userInvocable = frontmatter['user-invocable'];
  if (typeof userInvocable === 'boolean') {
    parsed['user-invocable'] = userInvocable;
  }

  const disableModelInvocation = frontmatter['disable-model-invocation'];
  if (typeof disableModelInvocation === 'boolean') {
    parsed['disable-model-invocation'] = disableModelInvocation;
  }

  const commandDispatch = frontmatter['command-dispatch'];
  if (typeof commandDispatch === 'string' && commandDispatch.length > 0) {
    if (commandDispatch !== 'tool') {
      return {
        ok: false,
        error: 'command-dispatch currently supports only "tool"',
      };
    }
    parsed['command-dispatch'] = 'tool';
  }

  const commandTool = frontmatter['command-tool'];
  if (typeof commandTool === 'string' && commandTool.trim().length > 0) {
    parsed['command-tool'] = commandTool.trim();
  }

  const commandArgMode = frontmatter['command-arg-mode'];
  if (typeof commandArgMode === 'string' && commandArgMode.trim().length > 0) {
    if (commandArgMode !== 'raw') {
      return {
        ok: false,
        error: 'command-arg-mode currently supports only "raw"',
      };
    }
    parsed['command-arg-mode'] = 'raw';
  }

  const metadataValue = frontmatter['metadata'];
  if (typeof metadataValue === 'string' && metadataValue.trim().length > 0) {
    parsed.metadata = metadataValue.trim();
  }

  if (parsed['command-dispatch'] === 'tool' && !parsed['command-tool']) {
    return {
      ok: false,
      error: 'command-tool is required when command-dispatch is "tool"',
    };
  }

  const metadata = parseMetadata(parsed.metadata);
  if (metadata.error) {
    return {
      ok: false,
      error: metadata.error,
    };
  }

  const skill: SkillDefinition = {
    name: parsed.name,
    description: parsed.description,
    location: '',
    sourceType: 'extra',
    body,
    homepage: parsed.homepage,
    userInvocable: parsed['user-invocable'] ?? true,
    disableModelInvocation: parsed['disable-model-invocation'] ?? false,
    commandDispatch: parsed['command-dispatch'],
    commandTool: parsed['command-tool'],
    commandArgMode: parsed['command-arg-mode'] ?? 'raw',
    metadata: metadata.value,
  };

  return {
    ok: true,
    value: skill,
  };
}

function parseMetadata(rawMetadata: string | undefined):
  | { value: SkillMetadataKeygate | undefined; error?: undefined }
  | { value?: undefined; error: string } {
  if (!rawMetadata) {
    return { value: undefined };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawMetadata);
  } catch (error) {
    return {
      error: `metadata must be valid single-line JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!parsedJson || typeof parsedJson !== 'object') {
    return {
      error: 'metadata must decode to an object',
    };
  }

  const asRecord = parsedJson as Record<string, unknown>;
  const keygate = asRecord['keygate'] ?? asRecord['openclaw'];
  if (!keygate) {
    return {
      value: undefined,
    };
  }

  if (typeof keygate !== 'object' || keygate === null) {
    return {
      error: 'metadata.keygate must be an object',
    };
  }

  return {
    value: keygate as SkillMetadataKeygate,
  };
}
