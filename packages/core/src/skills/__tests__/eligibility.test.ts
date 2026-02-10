import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KeygateConfig, SkillDefinition } from '../../types.js';
import { buildEligibilityContext, evaluateSkillEligibility } from '../eligibility.js';

function createConfig(): KeygateConfig {
  return {
    llm: {
      provider: 'ollama',
      model: 'llama3',
      apiKey: '',
      ollama: { host: 'http://127.0.0.1:11434' },
    },
    security: {
      mode: 'safe',
      spicyModeEnabled: false,
      workspacePath: '/tmp/keygate-skills-test',
      allowedBinaries: ['node'],
    },
    server: { port: 18790 },
    browser: {
      domainPolicy: 'none',
      domainAllowlist: [],
      domainBlocklist: [],
      traceRetentionDays: 7,
      mcpPlaywrightVersion: '0.0.64',
      artifactsPath: path.join('/tmp/keygate-skills-test', '.keygate-browser-runs'),
    },
    skills: {
      load: {
        watch: false,
        watchDebounceMs: 250,
        extraDirs: [],
        pluginDirs: [],
      },
      entries: {},
      install: { nodeManager: 'npm' },
    },
    discord: {
      token: '',
      prefix: '!keygate ',
    },
  };
}

function createSkill(partial: Partial<SkillDefinition>): SkillDefinition {
  return {
    name: 'repo-triage',
    description: 'desc',
    location: '/tmp/repo-triage',
    sourceType: 'workspace',
    body: 'body',
    userInvocable: true,
    disableModelInvocation: false,
    commandArgMode: 'raw',
    ...partial,
  };
}

describe('skill eligibility', () => {
  it('respects explicit disabled entry', () => {
    const config = createConfig();
    config.skills!.entries['repo-triage'] = { enabled: false };

    const result = evaluateSkillEligibility(createSkill({}), buildEligibilityContext(config));
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('disabled');
  });

  it('maps apiKey into primaryEnv overlay when missing in process env', () => {
    const config = createConfig();
    config.skills!.entries['repo-triage'] = { apiKey: 'secret-key' };

    const skill = createSkill({
      metadata: {
        primaryEnv: 'TEST_SKILL_KEY',
        requires: {
          env: ['TEST_SKILL_KEY'],
        },
      },
    });

    const result = evaluateSkillEligibility(skill, buildEligibilityContext(config));
    expect(result.eligible).toBe(true);
    expect(result.envOverlay['TEST_SKILL_KEY']).toBe('secret-key');
  });

  it('filters bundled skills when allowBundled list is set', () => {
    const config = createConfig();
    config.skills!.allowBundled = ['allowed-skill'];

    const result = evaluateSkillEligibility(
      createSkill({ name: 'blocked-skill', sourceType: 'bundled' }),
      buildEligibilityContext(config)
    );

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('bundled_not_allowed');
  });

  it('fails requires.anyBins when no candidate exists', () => {
    const config = createConfig();

    const result = evaluateSkillEligibility(
      createSkill({
        metadata: {
          requires: {
            anyBins: ['definitely-not-a-real-keygate-bin-1234', 'also-not-real-xyz'],
          },
        },
      }),
      buildEligibilityContext(config)
    );

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('missing_any_bins');
  });
});
