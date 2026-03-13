import { describe, expect, it } from 'vitest';
import type { KeygateConfig, LLMUsageSnapshot } from '../../types.js';
import { UsageService } from '../service.js';

function createConfig(): KeygateConfig {
  return {
    llm: {
      provider: 'openai-codex',
      model: 'openai-codex/gpt-5.3',
      apiKey: '',
      pricing: {
        overrides: {},
      },
    },
    security: {
      mode: 'safe',
      spicyModeEnabled: false,
      workspacePath: '/tmp/keygate-tests',
      allowedBinaries: [],
      sandbox: {
        backend: 'docker',
        scope: 'session',
        image: 'ghcr.io/openai/openhands-runtime:latest',
        networkAccess: true,
        degradeWithoutDocker: true,
      },
    },
    server: {
      host: '127.0.0.1',
      port: 18790,
      apiToken: '',
    },
    remote: {
      authMode: 'off',
      tailscale: { resetOnStop: false },
      ssh: { port: 22, localPort: 28790, remotePort: 18790 },
    },
    browser: {
      domainPolicy: 'none',
      domainAllowlist: [],
      domainBlocklist: [],
      traceRetentionDays: 7,
      mcpPlaywrightVersion: '0.0.64',
      artifactsPath: '/tmp/keygate-tests/browser',
    },
    discord: {
      token: '',
      prefix: '!keygate ',
      dmPolicy: 'pairing',
      allowFrom: [],
    },
    slack: {
      botToken: '',
      appToken: '',
      signingSecret: '',
      dmPolicy: 'pairing',
      allowFrom: [],
    },
    whatsapp: {
      dmPolicy: 'pairing',
      allowFrom: [],
      groupMode: 'closed',
      groups: {},
      groupRequireMentionDefault: true,
      sendReadReceipts: true,
    },
    gmail: {
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      redirectPort: 1488,
      defaults: {
        labelIds: [],
        watchRenewalMinutes: 1320,
      },
    },
    skills: {
      watch: false,
      watchDebounceMs: 0,
      nodeManager: 'pnpm',
      additionalPaths: [],
      allowBundled: true,
    },
    plugins: {
      watch: false,
      watchDebounceMs: 0,
      nodeManager: 'pnpm',
      entries: [],
    },
    memory: {
      provider: 'auto',
      vectorWeight: 0.7,
      textWeight: 0.3,
      maxResults: 6,
      minScore: 0.35,
      autoIndex: true,
      indexSessions: true,
      temporalDecay: false,
      temporalHalfLifeDays: 30,
      mmr: false,
    },
  };
}

function createService(): UsageService {
  return new UsageService({} as never, createConfig());
}

describe('UsageService.normalizeUsageSnapshot', () => {
  it('estimates token counts when the provider does not return usage', () => {
    const usage = createService().normalizeUsageSnapshot(
      {
        provider: 'openai-codex',
        model: 'openai-codex/gpt-5.3',
        inputTokens: Number.NaN,
        outputTokens: Number.NaN,
        cachedTokens: Number.NaN,
        totalTokens: Number.NaN,
      } as LLMUsageSnapshot,
      {
        provider: 'openai-codex',
        model: 'openai-codex/gpt-5.3',
        promptText: 'Summarize the current branch changes.',
        responseText: 'I found two modified files and one new test.',
        latencyMs: 250,
      },
    );

    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
    expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
    expect(usage.source).toBe('estimated');
    expect(usage.estimatedCost).toBe(true);
  });

  it('ignores all-zero provider usage payloads and falls back to estimation', () => {
    const usage = createService().normalizeUsageSnapshot(
      {
        provider: 'openai-codex',
        model: 'openai-codex/gpt-5.3',
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
      },
      {
        provider: 'openai-codex',
        model: 'openai-codex/gpt-5.3',
        promptText: 'Please summarize my unread inbox items.',
        responseText: 'You have three unread messages that need follow-up.',
      },
    );

    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
    expect(usage.totalTokens).toBeGreaterThan(0);
    expect(usage.source).toBe('estimated');
    expect(usage.estimatedCost).toBe(true);
  });
});
