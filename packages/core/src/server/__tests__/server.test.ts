import { describe, expect, it, vi } from 'vitest';
import {
  WebSocketChannel,
  applyDiscordConfigUpdate,
  applySpicyModeEnable,
  applySpicyObedienceUpdate,
  buildSessionChunkPayload,
  buildConnectedPayload,
  buildSessionMessageEndPayload,
  buildSessionSnapshotPayload,
  buildSessionUserMessagePayload,
  buildStatusPayload,
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
  it('always includes current web session and all discord sessions', () => {
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
      ],
    } as any;

    const payload = buildSessionSnapshotPayload(gateway, 'web:current');
    const sessions = payload['sessions'] as Array<Record<string, unknown>>;

    expect(payload['type']).toBe('session_snapshot');
    expect(sessions.map((session) => session['sessionId'])).toEqual([
      'web:current',
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
});

describe('session websocket event payloads', () => {
  it('maps gateway message events to session websocket messages', () => {
    expect(buildSessionUserMessagePayload({
      sessionId: 'discord:123',
      channelType: 'discord',
      content: 'hello',
    })).toEqual({
      type: 'session_user_message',
      sessionId: 'discord:123',
      channelType: 'discord',
      content: 'hello',
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
