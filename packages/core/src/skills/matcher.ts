import type { SkillDefinition } from '../types.js';
import type { SkillInvocation, SkillSelectionOptions, SkillSelectionResult } from './types.js';

const SLASH_PATTERN = /^\/([a-z0-9][a-z0-9-]{0,63})(?:\s+(.*))?$/i;
const SKILL_MENTION_PATTERN = /\$([a-z0-9][a-z0-9-]{0,63})/gi;

export function parseSlashSkillInvocation(content: string): SkillInvocation | null {
  const trimmed = content.trim();
  const match = trimmed.match(SLASH_PATTERN);
  if (!match) {
    return null;
  }

  const name = match[1]!.toLowerCase();
  const rawArgs = (match[2] ?? '').trim();

  return {
    name,
    commandName: `/${name}`,
    rawArgs,
  };
}

export function selectActiveSkills(
  skills: SkillDefinition[],
  message: string,
  options: SkillSelectionOptions
): SkillSelectionResult {
  const selected: SkillDefinition[] = [];

  if (options.explicitInvocation) {
    const explicitSkill = findByName(skills, options.explicitInvocation.name);
    if (explicitSkill) {
      selected.push(explicitSkill);
    }
  }

  const mentionNames = collectMentionedSkillNames(message);
  for (const mentionName of mentionNames) {
    if (selected.length >= options.maxActive) {
      break;
    }

    const skill = findByName(skills, mentionName);
    if (!skill || skill.disableModelInvocation) {
      continue;
    }

    if (!selected.some((entry) => entry.name === skill.name)) {
      selected.push(skill);
    }
  }

  if (selected.length < options.maxActive) {
    const autoMatches = scoreSkillsForMessage(skills, message)
      .filter((entry) => entry.score >= 2)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.skill.name.localeCompare(right.skill.name);
      })
      .slice(0, 2);

    for (const auto of autoMatches) {
      if (selected.length >= options.maxActive) {
        break;
      }

      if (auto.skill.disableModelInvocation) {
        continue;
      }

      if (!selected.some((entry) => entry.name === auto.skill.name)) {
        selected.push(auto.skill);
      }
    }
  }

  return {
    active: selected,
    activeEnv: {},
  };
}

function scoreSkillsForMessage(
  skills: SkillDefinition[],
  message: string
): Array<{ skill: SkillDefinition; score: number }> {
  const messageTokens = new Set(tokenize(message));

  return skills.map((skill) => {
    const skillTokens = new Set(tokenize(`${skill.name} ${skill.description}`));
    let score = 0;

    for (const token of skillTokens) {
      if (messageTokens.has(token)) {
        score += 1;
      }
    }

    return {
      skill,
      score,
    };
  });
}

function collectMentionedSkillNames(message: string): string[] {
  const result: string[] = [];
  let match: RegExpExecArray | null = null;

  SKILL_MENTION_PATTERN.lastIndex = 0;
  while ((match = SKILL_MENTION_PATTERN.exec(message)) !== null) {
    result.push(match[1]!.toLowerCase());
  }

  return Array.from(new Set(result));
}

function findByName(skills: SkillDefinition[], name: string): SkillDefinition | undefined {
  return skills.find((skill) => skill.name.toLowerCase() === name.toLowerCase());
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}
