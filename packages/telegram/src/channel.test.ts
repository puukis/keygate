import { describe, expect, it, vi } from 'vitest';
import { TelegramChannel, pendingConfirmations } from './channel.js';

async function* makeStream(chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe('TelegramChannel sendStream', () => {
  it('falls back to standard sends when the streaming placeholder cannot be created', async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('placeholder failed'))
      .mockResolvedValueOnce({ message_id: 200 });
    const editMessageText = vi.fn();
    const channel = new TelegramChannel({ sendMessage, editMessageText } as any, 123, 456);

    await channel.sendStream(makeStream(['Final response']));

    expect(editMessageText).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[1]).toBe('Final response');
  });

  it('falls back to standard sends when the final stream edit fails', async () => {
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ message_id: 100 })
      .mockResolvedValueOnce({ message_id: 200 });
    const editMessageText = vi.fn().mockRejectedValue(new Error('Bad Request: can\'t parse entities'));
    const channel = new TelegramChannel({ sendMessage, editMessageText } as any, 123, 456);

    await channel.sendStream(makeStream(['Final response']));

    expect(editMessageText).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[1]).toBe('Final response');
  });

  it('continues underneath the confirmation prompt after approval', async () => {
    const state: { releaseContinuation?: () => void } = {};
    const continueStream = new Promise<void>((resolve) => {
      state.releaseContinuation = resolve;
    });
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ message_id: 100 })
      .mockResolvedValueOnce({ message_id: 200 })
      .mockResolvedValueOnce({ message_id: 300 });
    const editMessageText = vi.fn().mockResolvedValue(true);
    const deleteMessage = vi.fn().mockResolvedValue(true);
    const channel = new TelegramChannel({ sendMessage, editMessageText, deleteMessage } as any, 123, 456);

    const streamPromise = channel.sendStream((async function* () {
      await continueStream;
      yield 'After';
    })());

    await Promise.resolve();
    await Promise.resolve();

    const confirmationPromise = channel.requestConfirmation('Confirm command');
    await vi.waitFor(() => expect(pendingConfirmations.size).toBe(1));

    expect(sendMessage.mock.calls[1]?.[2]).toMatchObject({
      reply_parameters: { message_id: 456 },
    });

    const resolver = pendingConfirmations.values().next().value as ((decision: 'allow_once' | 'allow_always' | 'cancel') => void) | undefined;
    expect(resolver).toBeDefined();
    resolver?.('allow_once');
    await confirmationPromise;

    if (state.releaseContinuation) {
      state.releaseContinuation();
    }
    await streamPromise;

    expect(deleteMessage).toHaveBeenCalledWith(123, 100);
    expect(sendMessage.mock.calls[2]?.[1]).toBe('…');
    expect(sendMessage.mock.calls[2]?.[2]).toMatchObject({
      reply_parameters: { message_id: 200 },
    });
    expect(editMessageText).toHaveBeenCalled();
    expect(editMessageText).toHaveBeenLastCalledWith(123, 300, 'After', { parse_mode: 'HTML' });
  });
});
