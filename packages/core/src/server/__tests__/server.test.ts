import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  WebSocketChannel,
  applyDiscordConfigUpdate,
  applySpicyModeEnable,
  applySpicyObedienceUpdate,
  buildSessionChunkPayload,
  buildBrowserStatusSignature,
  buildConnectedPayload,
  buildSessionMessageEndPayload,
  buildSessionSnapshotPayload,
  buildSessionUserMessagePayload,
  buildStatusPayload,
  applyBrowserPolicyUpdate,
  isPathWithinRoot,
  maybeRefreshCodexProviderForBrowserStatusChange,
  cleanupExpiredUploadedImages,
  resolveLatestSessionScreenshot,
  resolveUploadPathByAttachmentId,
  resolveSessionScreenshotByFilename,
  sanitizeBrowserScreenshotFilename,
  sanitizeBrowserSessionId,
  sanitizeUploadAttachmentId,
  sanitizeUploadSessionId,
  serveUploadedImageById,
  handleImageUploadRequest,
} from '../index.js';
describe('server spicy obedience payloads', () => {
  it('includes spicyObedienceEnabled in connected payload', () => {
    const gateway = {
      getSecurityMode: () => 'spicy' as const,
      getSpicyModeEnabled: () => true,
      getSpicyMaxObedienceEnabled: () => true,
      getLLMState: () => ({ provider: 'openai' as const, model: 'gpt-4o' }),
    } as any;
    const config = {
      discord: {
        token: 'discord-token',
        prefix: '!kg ',
      },
      browser: {
        domainPolicy: 'none',
        domainAllowlist: [],
        domainBlocklist: [],
        traceRetentionDays: 7,
        mcpPlaywrightVersion: '0.0.64',
        artifactsPath: '/tmp/keygate-browser',
      },
    } as any;

    const payload = buildConnectedPayload('session-1', gateway, gateway.getLLMState(), config);

    expect(payload['type']).toBe('connected');
    expect(payload['spicyEnabled']).toBe(true);
    expect(payload['spicyObedienceEnabled']).toBe(true);
    expect(payload['discord']).toEqual({
      configured: true,
      prefix: '!kg ',
    });
  });

  it('includes spicyObedienceEnabled in status payload', () => {
    const gateway = {
      getSecurityMode: () => 'safe' as const,
      getSpicyModeEnabled: () => false,
      getSpicyMaxObedienceEnabled: () => false,
      getLLMState: () => ({ provider: 'openai' as const, model: 'gpt-4o' }),
    } as any;
    const config = {
      discord: {
        token: '',
        prefix: '!keygate ',
      },
      browser: {
        domainPolicy: 'none',
        domainAllowlist: [],
        domainBlocklist: [],
        traceRetentionDays: 7,
        mcpPlaywrightVersion: '0.0.64',
        artifactsPath: '/tmp/keygate-browser',
      },
    } as any;

    const payload = buildStatusPayload(gateway, config);
    expect(payload['spicyEnabled']).toBe(false);
    expect(payload['spicyObedienceEnabled']).toBe(false);
    expect(payload['discord']).toEqual({
      configured: false,
      prefix: '!keygate ',
    });
  });
});

describe('session snapshot payload', () => {
  it('always includes current web session and all read-only channel sessions', () => {
    const gateway = {
      listSessions: () => [
        {
          id: 'web:other',
          channelType: 'web' as const,
          messages: [{ role: 'user' as const, content: 'hidden web chat' }],
          createdAt: new Date('2026-02-08T10:00:00.000Z'),
          updatedAt: new Date('2026-02-08T10:05:00.000Z'),
        },
        {
          id: 'discord:alpha',
          channelType: 'discord' as const,
          messages: [{ role: 'assistant' as const, content: 'discord latest' }],
          createdAt: new Date('2026-02-08T11:00:00.000Z'),
          updatedAt: new Date('2026-02-08T11:05:00.000Z'),
        },
        {
          id: 'terminal:alpha',
          channelType: 'terminal' as const,
          messages: [{ role: 'assistant' as const, content: 'terminal latest' }],
          createdAt: new Date('2026-02-08T11:06:00.000Z'),
          updatedAt: new Date('2026-02-08T11:07:00.000Z'),
        },
      ],
    } as any;

    const payload = buildSessionSnapshotPayload(gateway, 'web:current');
    const sessions = payload['sessions'] as Array<Record<string, unknown>>;

    expect(payload['type']).toBe('session_snapshot');
    expect(sessions.map((session) => session['sessionId'])).toEqual([
      'web:current',
      'terminal:alpha',
      'discord:alpha',
    ]);
  });

  it('serializes only user/assistant messages and keeps current web session first', () => {
    const gateway = {
      listSessions: () => [
        {
          id: 'discord:beta',
          channelType: 'discord' as const,
          messages: [
            { role: 'user' as const, content: 'u1' },
            { role: 'tool' as const, content: 'tool detail' },
            { role: 'assistant' as const, content: 'a1' },
          ],
          createdAt: new Date('2026-02-08T09:00:00.000Z'),
          updatedAt: new Date('2026-02-08T09:05:00.000Z'),
        },
        {
          id: 'web:current',
          channelType: 'web' as const,
          messages: [{ role: 'assistant' as const, content: 'main chat' }],
          createdAt: new Date('2026-02-08T12:00:00.000Z'),
          updatedAt: new Date('2026-02-08T12:01:00.000Z'),
        },
      ],
    } as any;

    const payload = buildSessionSnapshotPayload(gateway, 'web:current');
    const sessions = payload['sessions'] as Array<Record<string, unknown>>;
    const discordSession = sessions.find((session) => session['sessionId'] === 'discord:beta');

    expect(sessions[0]?.['sessionId']).toBe('web:current');
    expect(discordSession?.['messages']).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]);
  });

  it('includes user message attachments in snapshot serialization', () => {
    const gateway = {
      listSessions: () => [
        {
          id: 'web:current',
          channelType: 'web' as const,
          messages: [{
            role: 'user' as const,
            content: 'analyze this',
            attachments: [{
              id: 'att-1',
              filename: 'photo.png',
              contentType: 'image/png',
              sizeBytes: 1024,
              path: '/tmp/photo.png',
              url: '/api/uploads/image?sessionId=web%3Acurrent&id=att-1',
            }],
          }],
          createdAt: new Date('2026-02-08T12:00:00.000Z'),
          updatedAt: new Date('2026-02-08T12:01:00.000Z'),
        },
      ],
    } as any;

    const payload = buildSessionSnapshotPayload(gateway, 'web:current');
    const sessions = payload['sessions'] as Array<Record<string, unknown>>;
    const current = sessions.find((session) => session['sessionId'] === 'web:current');
    const messages = current?.['messages'] as Array<Record<string, unknown>>;
    const firstMessage = messages[0];

    expect(firstMessage).toEqual({
      role: 'user',
      content: 'analyze this',
      attachments: [{
        id: 'att-1',
        filename: 'photo.png',
        contentType: 'image/png',
        sizeBytes: 1024,
        url: '/api/uploads/image?sessionId=web%3Acurrent&id=att-1',
      }],
    });
  });
});

describe('session websocket event payloads', () => {
  it('maps gateway message events to session websocket messages', () => {
    expect(buildSessionUserMessagePayload({
      sessionId: 'discord:123',
      channelType: 'discord',
      content: 'hello',
      attachments: [{
        id: 'att-1',
        filename: 'chart.png',
        contentType: 'image/png',
        sizeBytes: 256,
        path: '/tmp/chart.png',
        url: '/api/uploads/image?sessionId=discord%3A123&id=att-1',
      }],
    })).toEqual({
      type: 'session_user_message',
      sessionId: 'discord:123',
      channelType: 'discord',
      content: 'hello',
      attachments: [{
        id: 'att-1',
        filename: 'chart.png',
        contentType: 'image/png',
        sizeBytes: 256,
        url: '/api/uploads/image?sessionId=discord%3A123&id=att-1',
      }],
    });

    expect(buildSessionChunkPayload({
      sessionId: 'web:1',
      content: 'part',
    })).toEqual({
      type: 'session_chunk',
      sessionId: 'web:1',
      content: 'part',
    });

    expect(buildSessionMessageEndPayload({
      sessionId: 'web:1',
      content: 'done',
    })).toEqual({
      type: 'session_message_end',
      sessionId: 'web:1',
      content: 'done',
    });
  });
});

describe('applySpicyModeEnable', () => {
  it('enables spicy mode and persists env state', async () => {
    let enabled = false;
    const gateway = {
      getSpicyModeEnabled: () => enabled,
      setSpicyModeEnabled: (next: boolean) => {
        enabled = next;
      },
    } as any;
    const persistEnvUpdate = vi.fn(async () => undefined);

    await applySpicyModeEnable(gateway, persistEnvUpdate);

    expect(enabled).toBe(true);
    expect(persistEnvUpdate).toHaveBeenCalledWith({
      SPICY_MODE_ENABLED: 'true',
    });
  });

  it('reverts in-memory state when spicy mode enable persistence fails', async () => {
    let enabled = false;
    const gateway = {
      getSpicyModeEnabled: () => enabled,
      setSpicyModeEnabled: (next: boolean) => {
        enabled = next;
      },
    } as any;

    await expect(
      applySpicyModeEnable(
        gateway,
        async () => {
          throw new Error('disk write failed');
        }
      )
    ).rejects.toThrow('disk write failed');

    expect(enabled).toBe(false);
  });
});

describe('applySpicyObedienceUpdate', () => {
  it('updates gateway and persists env state', async () => {
    let enabled = false;
    const gateway = {
      getSpicyMaxObedienceEnabled: () => enabled,
      setSpicyMaxObedienceEnabled: (next: boolean) => {
        enabled = next;
      },
    } as any;
    const persistEnvUpdate = vi.fn(async () => undefined);

    await applySpicyObedienceUpdate(gateway, true, persistEnvUpdate);

    expect(enabled).toBe(true);
    expect(persistEnvUpdate).toHaveBeenCalledWith({
      SPICY_MAX_OBEDIENCE_ENABLED: 'true',
    });
  });

  it('reverts in-memory state when persistence fails', async () => {
    let enabled = false;
    const gateway = {
      getSpicyMaxObedienceEnabled: () => enabled,
      setSpicyMaxObedienceEnabled: (next: boolean) => {
        enabled = next;
      },
    } as any;

    await expect(
      applySpicyObedienceUpdate(
        gateway,
        true,
        async () => {
          throw new Error('disk write failed');
        }
      )
    ).rejects.toThrow('disk write failed');

    expect(enabled).toBe(false);
  });
});

describe('applyDiscordConfigUpdate', () => {
  it('updates prefix and token when both are provided', async () => {
    const config = {
      discord: {
        token: '',
        prefix: '!keygate ',
      },
    } as any;
    const persistEnvUpdate = vi.fn(async () => undefined);

    const result = await applyDiscordConfigUpdate(
      config,
      {
        prefix: '!kg ',
        token: 'new-token',
      },
      persistEnvUpdate
    );

    expect(persistEnvUpdate).toHaveBeenCalledWith({
      DISCORD_PREFIX: '!kg ',
      DISCORD_TOKEN: 'new-token',
    });
    expect(result).toEqual({
      configured: true,
      prefix: '!kg ',
    });
    expect(config.discord).toEqual({
      token: 'new-token',
      prefix: '!kg ',
    });
  });

  it('keeps existing token when token field is omitted', async () => {
    const config = {
      discord: {
        token: 'existing-token',
        prefix: '!keygate ',
      },
    } as any;
    const persistEnvUpdate = vi.fn(async () => undefined);

    const result = await applyDiscordConfigUpdate(
      config,
      {
        prefix: '?keygate ',
      },
      persistEnvUpdate
    );

    expect(persistEnvUpdate).toHaveBeenCalledWith({
      DISCORD_PREFIX: '?keygate ',
    });
    expect(result).toEqual({
      configured: true,
      prefix: '?keygate ',
    });
    expect(config.discord).toEqual({
      token: 'existing-token',
      prefix: '?keygate ',
    });
  });

  it('clears token when clearToken is requested', async () => {
    const config = {
      discord: {
        token: 'existing-token',
        prefix: '!keygate ',
      },
    } as any;
    const persistEnvUpdate = vi.fn(async () => undefined);

    const result = await applyDiscordConfigUpdate(
      config,
      {
        prefix: '!keygate ',
        clearToken: true,
      },
      persistEnvUpdate
    );

    expect(persistEnvUpdate).toHaveBeenCalledWith({
      DISCORD_PREFIX: '!keygate ',
      DISCORD_TOKEN: '',
    });
    expect(result).toEqual({
      configured: false,
      prefix: '!keygate ',
    });
    expect(config.discord).toEqual({
      token: '',
      prefix: '!keygate ',
    });
  });

  it('normalizes comma-separated prefixes when saving config', async () => {
    const config = {
      discord: {
        token: 'existing-token',
        prefix: '!keygate ',
      },
    } as any;
    const persistEnvUpdate = vi.fn(async () => undefined);

    const result = await applyDiscordConfigUpdate(
      config,
      {
        prefix: '1, 2,3 , 4',
      },
      persistEnvUpdate
    );

    expect(persistEnvUpdate).toHaveBeenCalledWith({
      DISCORD_PREFIX: '1, 2, 3, 4',
    });
    expect(result).toEqual({
      configured: true,
      prefix: '1, 2, 3, 4',
    });
    expect(config.discord).toEqual({
      token: 'existing-token',
      prefix: '1, 2, 3, 4',
    });
  });

  it('rejects empty comma-separated prefix lists', async () => {
    const config = {
      discord: {
        token: 'existing-token',
        prefix: '!keygate ',
      },
    } as any;

    await expect(
      applyDiscordConfigUpdate(
        config,
        {
          prefix: ',,,',
        },
        async () => undefined
      )
    ).rejects.toThrow('Discord prefix list cannot be empty.');
  });
});

describe('WebSocketChannel confirmation flow', () => {
  it('waits for explicit confirmation response without auto-canceling', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const ws = { send, readyState: 1 } as any;
      const channel = new WebSocketChannel(ws, 'session-1');
      let settled = false;

      const confirmationPromise = channel.requestConfirmation('Confirm command').then((decision) => {
        settled = true;
        return decision;
      });

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(settled).toBe(false);

      channel.handleConfirmResponse('allow_once');
      await expect(confirmationPromise).resolves.toBe('allow_once');
      expect(send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toMatchObject({
        type: 'confirm_request',
        sessionId: 'session-1',
        prompt: 'Confirm command',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues concurrent confirmation requests and resolves them in order', async () => {
    const send = vi.fn();
    const ws = { send, readyState: 1 } as any;
    const channel = new WebSocketChannel(ws, 'session-queue');

    const first = channel.requestConfirmation('First');
    const second = channel.requestConfirmation('Second');

    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toMatchObject({
      prompt: 'First',
    });

    channel.handleConfirmResponse('allow_once');
    await expect(first).resolves.toBe('allow_once');

    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[1]?.[0] as string)).toMatchObject({
      prompt: 'Second',
    });

    channel.handleConfirmResponse('cancel');
    await expect(second).resolves.toBe('cancel');
  });

  it('cancels pending confirmations when websocket disconnects', async () => {
    const send = vi.fn();
    const ws = { send, readyState: 1 } as any;
    const channel = new WebSocketChannel(ws, 'session-disconnect');

    const first = channel.requestConfirmation('First');
    const second = channel.requestConfirmation('Second');

    channel.handleDisconnect();

    await expect(first).resolves.toBe('cancel');
    await expect(second).resolves.toBe('cancel');
  });
});

describe('browser policy update', () => {
  it('persists browser policy settings and updates in-memory config', async () => {
    const config = {
      browser: {
        domainPolicy: 'none',
        domainAllowlist: [],
        domainBlocklist: [],
        traceRetentionDays: 7,
        mcpPlaywrightVersion: '0.0.64',
        artifactsPath: '/tmp/keygate-browser',
      },
    } as any;

    const persistEnvUpdate = vi.fn(async () => undefined);

    const view = await applyBrowserPolicyUpdate(
      config,
      {
        domainPolicy: 'allowlist',
        domainAllowlist: ['https://example.com', ' https://docs.example.com '],
        traceRetentionDays: 10,
        mcpPlaywrightVersion: '0.0.70',
      },
      persistEnvUpdate,
    );

    expect(persistEnvUpdate).toHaveBeenCalledWith({
      BROWSER_DOMAIN_POLICY: 'allowlist',
      BROWSER_DOMAIN_ALLOWLIST: 'https://example.com, https://docs.example.com',
      BROWSER_DOMAIN_BLOCKLIST: '',
      BROWSER_TRACE_RETENTION_DAYS: '10',
      MCP_PLAYWRIGHT_VERSION: '0.0.70',
    });

    expect(config.browser).toMatchObject({
      domainPolicy: 'allowlist',
      domainAllowlist: ['https://example.com', 'https://docs.example.com'],
      traceRetentionDays: 10,
      mcpPlaywrightVersion: '0.0.70',
    });

    expect(view.domainPolicy).toBe('allowlist');
    expect(view.desiredVersion).toBe('0.0.70');
  });

  it('rejects allowlist mode without domains', async () => {
    const config = {
      browser: {
        domainPolicy: 'none',
        domainAllowlist: [],
        domainBlocklist: [],
        traceRetentionDays: 7,
        mcpPlaywrightVersion: '0.0.64',
        artifactsPath: '/tmp/keygate-browser',
      },
    } as any;

    await expect(
      applyBrowserPolicyUpdate(
        config,
        {
          domainPolicy: 'allowlist',
          domainAllowlist: [],
        },
        async () => undefined,
      ),
    ).rejects.toThrow('Allowlist policy requires at least one allowed origin.');
  });
});

describe('codex browser context refresh', () => {
  function makeBrowserStatus(overrides: Partial<Record<string, unknown>> = {}): any {
    return {
      installed: true,
      healthy: true,
      serverName: 'playwright',
      configuredVersion: '0.0.64',
      desiredVersion: '0.0.64',
      domainPolicy: 'none',
      domainAllowlist: [],
      domainBlocklist: [],
      traceRetentionDays: 7,
      artifactsPath: '/tmp/keygate-browser',
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.64'],
      ...overrides,
    };
  }

  it('initializes tracker baseline without refreshing provider', async () => {
    const gateway = {
      getLLMState: vi.fn(() => ({
        provider: 'openai-codex',
        model: 'openai-codex/gpt-5.3',
        reasoningEffort: 'medium',
      })),
      setLLMSelection: vi.fn(async () => undefined),
    } as any;
    const tracker = { hasBaseline: false, signature: null };
    const status = makeBrowserStatus();

    await maybeRefreshCodexProviderForBrowserStatusChange(gateway, status, tracker);

    expect(tracker.hasBaseline).toBe(true);
    expect(tracker.signature).toBe(buildBrowserStatusSignature(status));
    expect(gateway.setLLMSelection).not.toHaveBeenCalled();
  });

  it('refreshes codex provider when browser status signature changes', async () => {
    const gateway = {
      getLLMState: vi.fn(() => ({
        provider: 'openai-codex',
        model: 'openai-codex/gpt-5.3',
        reasoningEffort: 'medium',
      })),
      setLLMSelection: vi.fn(async () => undefined),
    } as any;
    const tracker = {
      hasBaseline: true,
      signature: buildBrowserStatusSignature(makeBrowserStatus()),
    };
    const nextStatus = makeBrowserStatus({
      args: ['-y', '@playwright/mcp@0.0.70'],
      configuredVersion: '0.0.70',
      desiredVersion: '0.0.70',
    });

    await maybeRefreshCodexProviderForBrowserStatusChange(gateway, nextStatus, tracker);

    expect(gateway.setLLMSelection).toHaveBeenCalledWith(
      'openai-codex',
      'openai-codex/gpt-5.3',
      'medium'
    );
    expect(tracker.signature).toBe(buildBrowserStatusSignature(nextStatus));
  });

  it('does not refresh provider for non-codex LLM selection', async () => {
    const gateway = {
      getLLMState: vi.fn(() => ({
        provider: 'openai',
        model: 'gpt-4o',
      })),
      setLLMSelection: vi.fn(async () => undefined),
    } as any;
    const tracker = {
      hasBaseline: true,
      signature: buildBrowserStatusSignature(makeBrowserStatus({ configuredVersion: '0.0.64' })),
    };
    const nextStatus = makeBrowserStatus({
      args: ['-y', '@playwright/mcp@0.0.70'],
      configuredVersion: '0.0.70',
      desiredVersion: '0.0.70',
    });

    await maybeRefreshCodexProviderForBrowserStatusChange(gateway, nextStatus, tracker);

    expect(gateway.setLLMSelection).not.toHaveBeenCalled();
    expect(tracker.signature).toBe(buildBrowserStatusSignature(nextStatus));
  });
});

describe('browser screenshot security helpers', () => {
  it('sanitizes session id input and rejects traversal patterns', () => {
    expect(sanitizeBrowserSessionId('web:123')).toBe('web:123');
    expect(sanitizeBrowserSessionId('../etc/passwd')).toBeNull();
    expect(sanitizeBrowserSessionId('web:abc/def')).toBeNull();
  });

  it('finds the latest screenshot for a session prefix', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-screenshots-'));
    const first = path.join(root, 'session-web:1-step-1.png');
    const second = path.join(root, 'session-web:1-step-2.png');
    const other = path.join(root, 'session-web:2-step-1.png');

    await fs.writeFile(first, 'first', 'utf8');
    await fs.writeFile(second, 'second', 'utf8');
    await fs.writeFile(other, 'other', 'utf8');

    const firstTime = new Date(Date.now() - 30_000);
    const secondTime = new Date(Date.now() - 5_000);
    const otherTime = new Date(Date.now() - 1_000);

    await fs.utimes(first, firstTime, firstTime);
    await fs.utimes(second, secondTime, secondTime);
    await fs.utimes(other, otherTime, otherTime);

    const latest = await resolveLatestSessionScreenshot(root, 'web:1');
    expect(latest).toBe(path.resolve(second));
  });

  it('finds legacy workspace-root screenshots using artifacts path input', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-workspace-'));
    const artifactsRoot = path.join(workspaceRoot, '.keygate-browser-runs');
    await fs.mkdir(artifactsRoot, { recursive: true });

    const artifactsFile = path.join(artifactsRoot, 'session-web:1-step-1.png');
    const legacyRootFile = path.join(workspaceRoot, 'session-web:1-step-2.png');

    await fs.writeFile(artifactsFile, 'artifact', 'utf8');
    await fs.writeFile(legacyRootFile, 'legacy', 'utf8');

    const artifactsTime = new Date(Date.now() - 30_000);
    const legacyTime = new Date(Date.now() - 1_000);
    await fs.utimes(artifactsFile, artifactsTime, artifactsTime);
    await fs.utimes(legacyRootFile, legacyTime, legacyTime);

    const latest = await resolveLatestSessionScreenshot(artifactsRoot, 'web:1');
    expect(latest).toBe(path.resolve(legacyRootFile));
  });

  it('sanitizes screenshot filename input and rejects traversal patterns', () => {
    expect(sanitizeBrowserScreenshotFilename('session-web:123-step-1.png')).toBe('session-web:123-step-1.png');
    expect(sanitizeBrowserScreenshotFilename('../session-web:123-step-1.png')).toBeNull();
    expect(sanitizeBrowserScreenshotFilename('session-web:123-step-1.jpg')).toBeNull();
    expect(sanitizeBrowserScreenshotFilename('')).toBeNull();
  });

  it('resolves exact screenshot file by filename across browser roots', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-workspace-file-'));
    const artifactsRoot = path.join(workspaceRoot, '.keygate-browser-runs');
    await fs.mkdir(artifactsRoot, { recursive: true });

    const artifactsFile = path.join(artifactsRoot, 'session-web:1-step-1.png');
    const workspaceFile = path.join(workspaceRoot, 'session-web:1-step-1.png');

    await fs.writeFile(artifactsFile, 'artifact', 'utf8');
    await fs.writeFile(workspaceFile, 'workspace', 'utf8');

    const artifactsTime = new Date(Date.now() - 30_000);
    const workspaceTime = new Date(Date.now() - 1_000);
    await fs.utimes(artifactsFile, artifactsTime, artifactsTime);
    await fs.utimes(workspaceFile, workspaceTime, workspaceTime);

    const resolved = await resolveSessionScreenshotByFilename(
      artifactsRoot,
      'session-web:1-step-1.png'
    );
    expect(resolved).toBe(path.resolve(workspaceFile));
  });

  it('rejects out-of-root paths', () => {
    const root = '/tmp/keygate-browser-root';
    expect(isPathWithinRoot(root, '/tmp/keygate-browser-root/session-web:1-step-1.png')).toBe(true);
    expect(isPathWithinRoot(root, '/tmp/keygate-browser-root/../secret.png')).toBe(false);
  });
});

describe('image upload helpers', () => {
  it('sanitizes upload session/id values and rejects traversal', () => {
    expect(sanitizeUploadSessionId('web:123')).toBe('web:123');
    expect(sanitizeUploadSessionId('../etc/passwd')).toBeNull();
    expect(sanitizeUploadSessionId('web:abc/def')).toBeNull();

    expect(sanitizeUploadAttachmentId('abc-123_DEF')).toBe('abc-123_DEF');
    expect(sanitizeUploadAttachmentId('../../bad')).toBeNull();
    expect(sanitizeUploadAttachmentId('')).toBeNull();
  });

  it('resolves upload files by attachment id under session root', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-upload-resolve-'));
    const sessionDir = path.join(workspaceRoot, '.keygate-uploads', 'web:test');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, 'att-1.png'), 'png-data', 'utf8');

    const found = await resolveUploadPathByAttachmentId(workspaceRoot, 'web:test', 'att-1');
    const missing = await resolveUploadPathByAttachmentId(workspaceRoot, 'web:test', 'missing');

    expect(found).toBe(path.resolve(path.join(sessionDir, 'att-1.png')));
    expect(missing).toBeNull();
  });

  it('rejects upload requests with invalid session id, mime type, or oversized body', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-upload-validate-'));

    const invalidSession = await invokeUpload({
      workspacePath: workspaceRoot,
      sessionId: '../etc/passwd',
      contentType: 'image/png',
      body: Buffer.from('a'),
    });
    expect(invalidSession.statusCode).toBe(400);

    const invalidMime = await invokeUpload({
      workspacePath: workspaceRoot,
      sessionId: 'web:test',
      contentType: 'text/plain',
      body: Buffer.from('a'),
    });
    expect(invalidMime.statusCode).toBe(415);

    const oversized = await invokeUpload({
      workspacePath: workspaceRoot,
      sessionId: 'web:test',
      contentType: 'image/png',
      body: Buffer.alloc(10 * 1024 * 1024 + 1, 1),
    });
    expect(oversized.statusCode).toBe(413);
  });

  it('stores and serves uploaded images with session/id validation', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-upload-store-'));

    const upload = await invokeUpload({
      workspacePath: workspaceRoot,
      sessionId: 'web:test',
      contentType: 'image/png',
      body: Buffer.from('png-bytes'),
    });

    expect(upload.statusCode).toBe(200);
    const payload = JSON.parse(upload.body.toString('utf8')) as Record<string, unknown>;
    expect(typeof payload['id']).toBe('string');
    expect(payload['contentType']).toBe('image/png');
    expect(payload['sizeBytes']).toBe(9);

    const attachmentId = String(payload['id']);

    const served = await invokeServeUpload({
      workspacePath: workspaceRoot,
      method: 'GET',
      sessionId: 'web:test',
      attachmentId,
    });

    expect(served.statusCode).toBe(200);
    expect(served.headers['Content-Type']).toBe('image/png');
    expect(served.body.toString('utf8')).toBe('png-bytes');

    const invalidLookup = await invokeServeUpload({
      workspacePath: workspaceRoot,
      method: 'GET',
      sessionId: '../bad',
      attachmentId,
    });
    expect(invalidLookup.statusCode).toBe(400);
  });

  it('removes uploaded files older than retention window', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-upload-retention-'));
    const sessionDir = path.join(workspaceRoot, '.keygate-uploads', 'web:test');
    const oldFile = path.join(sessionDir, 'old.png');
    const freshFile = path.join(sessionDir, 'fresh.png');

    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(oldFile, 'old', 'utf8');
    await fs.writeFile(freshFile, 'fresh', 'utf8');

    const now = Date.now();
    const oldTime = new Date(now - (31 * 24 * 60 * 60 * 1000));
    const freshTime = new Date(now - 1_000);
    await fs.utimes(oldFile, oldTime, oldTime);
    await fs.utimes(freshFile, freshTime, freshTime);

    await cleanupExpiredUploadedImages(workspaceRoot, 30 * 24 * 60 * 60 * 1000);

    await expect(fs.access(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(freshFile)).resolves.toBeUndefined();
  });
});

type MockResponseResult = {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
};

async function invokeUpload(args: {
  workspacePath: string;
  sessionId: string;
  contentType: string;
  body: Buffer;
}): Promise<MockResponseResult> {
  const req = new PassThrough() as PassThrough & {
    headers: Record<string, string>;
  };
  req.headers = {
    'content-type': args.contentType,
  };

  const url = new URL(`http://localhost/api/uploads/image?sessionId=${encodeURIComponent(args.sessionId)}`);
  const response = createMockResponse();

  const pending = handleImageUploadRequest(req as any, response.res as any, url, args.workspacePath);
  req.end(args.body);
  await pending;

  return response.result();
}

async function invokeServeUpload(args: {
  workspacePath: string;
  method: 'GET' | 'HEAD';
  sessionId: string;
  attachmentId: string;
}): Promise<MockResponseResult> {
  const url = new URL(
    `http://localhost/api/uploads/image?sessionId=${encodeURIComponent(args.sessionId)}&id=${encodeURIComponent(args.attachmentId)}`
  );
  const response = createMockResponse();

  await serveUploadedImageById(response.res as any, args.method, url, args.workspacePath);
  return response.result();
}

function createMockResponse(): {
  res: {
    writeHead: (statusCode: number, headers?: Record<string, string>) => void;
    end: (chunk?: unknown) => void;
  };
  result: () => MockResponseResult;
} {
  let statusCode = 200;
  let headers: Record<string, string> = {};
  const chunks: Buffer[] = [];

  return {
    res: {
      writeHead: (nextStatusCode: number, nextHeaders?: Record<string, string>) => {
        statusCode = nextStatusCode;
        headers = { ...(nextHeaders ?? {}) };
      },
      end: (chunk?: unknown) => {
        if (chunk === undefined || chunk === null) {
          return;
        }

        if (Buffer.isBuffer(chunk)) {
          chunks.push(chunk);
          return;
        }

        chunks.push(Buffer.from(String(chunk), 'utf8'));
      },
    },
    result: () => ({
      statusCode,
      headers,
      body: Buffer.concat(chunks),
    }),
  };
}
