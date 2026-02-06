import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexRpcClient } from '../CodexRpcClient.js';

class FakeChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    if (this.killed) {
      return true;
    }

    this.killed = true;
    this.emit('exit', 0, null);
    return true;
  }
}

describe('CodexRpcClient', () => {
  it('correlates out-of-order JSON-RPC responses by id', async () => {
    const fake = new FakeChildProcess();
    const writes: string[] = [];

    fake.stdin.on('data', (chunk) => {
      writes.push(String(chunk));
    });

    const client = new CodexRpcClient({
      requestTimeoutMs: 5_000,
      spawnFactory: () => fake as any,
    });

    await client.start();

    const onePromise = client.request<{ value: number }>('first/method', { sample: 1 });
    const twoPromise = client.request<{ value: number }>('second/method', { sample: 2 });

    const parsedWrites = writes
      .join('')
      .split(/\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id: number; method: string });

    const firstRequest = parsedWrites.find((payload) => payload.method === 'first/method');
    const secondRequest = parsedWrites.find((payload) => payload.method === 'second/method');

    expect(firstRequest?.id).toBeTypeOf('number');
    expect(secondRequest?.id).toBeTypeOf('number');

    fake.stdout.write(JSON.stringify({
      id: secondRequest!.id,
      result: { value: 2 },
    }) + '\n');

    fake.stdout.write(JSON.stringify({
      id: firstRequest!.id,
      result: { value: 1 },
    }) + '\n');

    await expect(twoPromise).resolves.toEqual({ value: 2 });
    await expect(onePromise).resolves.toEqual({ value: 1 });

    await client.stop();
  });

  it('emits notifications from JSONL stdout', async () => {
    const fake = new FakeChildProcess();
    const client = new CodexRpcClient({
      requestTimeoutMs: 5_000,
      spawnFactory: () => fake as any,
    });

    await client.start();

    const notificationPromise = new Promise<{ step: string }>((resolve) => {
      client.once('notification', (notification) => {
        resolve(notification.params as { step: string });
      });
    });

    fake.stdout.write(JSON.stringify({
      method: 'turn/completed',
      params: { step: 'done' },
    }) + '\n');

    await expect(notificationPromise).resolves.toEqual({ step: 'done' });

    await client.stop();
  });

  it('retries with a reasoning-effort compat override for invalid config variants', async () => {
    const first = new FakeChildProcess();
    const second = new FakeChildProcess();
    const spawnCalls: string[][] = [];

    let firstFailed = false;
    first.stdin.on('data', () => {
      if (firstFailed) {
        return;
      }

      firstFailed = true;
      first.stderr.write('Error: error loading config: unknown variant `xhigh`, expected one of `none`, `minimal`, `low`, `medium`, `high`\nin `model_reasoning_effort`\n');
      setTimeout(() => {
        first.emit('exit', 1, null);
      }, 0);
    });

    second.stdin.on('data', (chunk) => {
      const lines = String(chunk)
        .split(/\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        const payload = JSON.parse(line) as { id?: number; method: string };
        if (payload.method === 'initialize') {
          second.stdout.write(JSON.stringify({
            id: payload.id,
            result: { sessionId: 'ok' },
          }) + '\n');
        }
      }
    });

    const client = new CodexRpcClient({
      requestTimeoutMs: 2_000,
      modelReasoningEffort: 'xhigh',
      spawnFactory: (_command, args) => {
        spawnCalls.push([...args]);
        return spawnCalls.length === 1 ? first as any : second as any;
      },
    });

    await client.ensureInitialized();

    expect(spawnCalls.length).toBe(2);
    expect(spawnCalls[0]).toContain('-c');
    expect(spawnCalls[0]).toContain('model_reasoning_effort="high"');
    expect(spawnCalls[1]).toContain('-c');
    expect(spawnCalls[1]).toContain('model_reasoning_effort="high"');
    expect(spawnCalls[1]).not.toContain('model_reasoning_effort="xhigh"');

    await client.stop();
  });
});
