import { createHash } from 'node:crypto';
import type { SkillDefinition } from '../types.js';

export interface SkillPromptBodyOptions {
  maxActive: number;
  maxBodyCharsPerSkill: number;
  maxBodyCharsTotal: number;
}

const DEFAULT_OPTIONS: SkillPromptBodyOptions = {
  maxActive: 3,
  maxBodyCharsPerSkill: 6000,
  maxBodyCharsTotal: 15000,
};

export function formatSkillsForPrompt(skills: SkillDefinition[]): string {
  if (skills.length === 0) {
    return '';
  }

  const rows = skills
    .map((skill) => (
      `  <skill>\n` +
      `    <name>${escapeXml(skill.name)}</name>\n` +
      `    <description>${escapeXml(skill.description)}</description>\n` +
      `    <location>${escapeXml(skill.location)}</location>\n` +
      `  </skill>`
    ));

  return `<skills>\n${rows.join('\n')}\n</skills>`;
}

export function buildActiveSkillsPrompt(
  skills: SkillDefinition[],
  options: Partial<SkillPromptBodyOptions> = {}
): { prompt: string; included: SkillDefinition[] } {
  if (skills.length === 0) {
    return { prompt: '', included: [] };
  }

  const resolved: SkillPromptBodyOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  const selected = skills.slice(0, resolved.maxActive);
  const blocks: string[] = [];
  const included: SkillDefinition[] = [];
  let consumed = 0;

  for (const skill of selected) {
    if (consumed >= resolved.maxBodyCharsTotal) {
      break;
    }

    const remaining = resolved.maxBodyCharsTotal - consumed;
    const perSkillLimit = Math.min(resolved.maxBodyCharsPerSkill, remaining);
    const body = truncate(skill.body, perSkillLimit);

    consumed += body.length;
    included.push(skill);
    blocks.push(
      `### Skill: ${skill.name}\n` +
      `${body}`
    );
  }

  if (blocks.length === 0) {
    return { prompt: '', included: [] };
  }

  return {
    prompt: ['ACTIVE SKILL INSTRUCTIONS', ...blocks].join('\n\n'),
    included,
  };
}

export function computeSkillContextHash(input: {
  snapshotVersion: string;
  skillListXml: string;
  activeSkillsPrompt: string;
  explicitSkillName?: string;
}): string {
  return createHash('sha256')
    .update(input.snapshotVersion)
    .update('\n')
    .update(input.skillListXml)
    .update('\n')
    .update(input.activeSkillsPrompt)
    .update('\n')
    .update(input.explicitSkillName ?? '')
    .digest('hex')
    .slice(0, 16);
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, Math.max(0, limit - 12))}\n[truncated]`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
