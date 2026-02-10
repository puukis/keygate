import { describe, expect, it } from 'vitest';
import type { SkillDefinition } from '../../types.js';
import { parseSlashSkillInvocation, selectActiveSkills } from '../matcher.js';

function skill(name: string, description: string, disableModelInvocation = false): SkillDefinition {
  return {
    name,
    description,
    location: `/tmp/${name}`,
    sourceType: 'workspace',
    body: `body for ${name}`,
    userInvocable: true,
    disableModelInvocation,
    commandArgMode: 'raw',
  };
}

describe('skill matcher', () => {
  it('parses slash invocation name and raw args', () => {
    const parsed = parseSlashSkillInvocation('/repo-triage check failing tests');
    expect(parsed).toEqual({
      name: 'repo-triage',
      commandName: '/repo-triage',
      rawArgs: 'check failing tests',
    });
  });

  it('returns null for non-slash content', () => {
    expect(parseSlashSkillInvocation('repo-triage')).toBeNull();
  });

  it('prefers explicit invocation and mention before auto-match', () => {
    const skills = [
      skill('repo-triage', 'debug repo failures quickly'),
      skill('safe-refactor', 'refactor code safely with tests'),
      skill('release-guard', 'prepare releases and publish checks'),
    ];

    const result = selectActiveSkills(
      skills,
      'Please run $safe-refactor to clean this repo and then release checks',
      {
        explicitInvocation: {
          name: 'repo-triage',
          commandName: '/repo-triage',
          rawArgs: '',
        },
        maxActive: 3,
      }
    );

    expect(result.active.map((entry) => entry.name)).toEqual([
      'repo-triage',
      'safe-refactor',
      'release-guard',
    ]);
  });

  it('skips disable-model-invocation skills for mention/auto but keeps explicit invocation', () => {
    const skills = [
      skill('channel-ops', 'run channel operations quickly', true),
      skill('repo-triage', 'debug repo failures quickly'),
    ];

    const mentionOnly = selectActiveSkills(skills, 'Please use $channel-ops', { maxActive: 3 });
    expect(mentionOnly.active.map((entry) => entry.name)).toEqual([]);

    const explicit = selectActiveSkills(skills, '/channel-ops gateway status', {
      explicitInvocation: {
        name: 'channel-ops',
        commandName: '/channel-ops',
        rawArgs: 'gateway status',
      },
      maxActive: 3,
    });

    expect(explicit.active.map((entry) => entry.name)).toEqual(['channel-ops']);
  });
});
