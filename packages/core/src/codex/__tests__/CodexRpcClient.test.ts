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

  it('auto-responds to server approval requests to prevent turn deadlocks', async () => {
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

    fake.stdout.write(JSON.stringify({
      id: 42,
      method: 'execCommandApproval',
      params: {
        conversationId: 'conv-1',
        callId: 'call-1',
        command: ['echo', 'hello'],
        cwd: '/tmp',
        reason: null,
        risk: null,
        parsedCmd: [],
      },
    }) + '\n');

    await new Promise((resolve) => setTimeout(resolve, 10));

    const payloads = writes
      .join('')
      .split(/\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id?: number; result?: Record<string, unknown> });

    const approvalResponse = payloads.find((payload) => payload.id === 42);

    expect(approvalResponse).toBeDefined();
    expect(approvalResponse?.result).toMatchObject({ decision: 'approved' });

    await client.stop();
  });

  it('uses a custom server request handler when provided', async () => {
    const fake = new FakeChildProcess();
    const writes: string[] = [];

    fake.stdin.on('data', (chunk) => {
      writes.push(String(chunk));
    });

    const client = new CodexRpcClient({
      requestTimeoutMs: 5_000,
      spawnFactory: () => fake as any,
      serverRequestHandler: async (request) => {
        if (request.method === 'execCommandApproval') {
          return { result: { decision: 'approved_for_session' } };
        }
        return null;
      },
    });

    await client.start();

    fake.stdout.write(JSON.stringify({
      id: 77,
      method: 'execCommandApproval',
      params: {
        conversationId: 'conv-1',
        callId: 'call-1',
        command: ['echo', 'hello'],
        cwd: '/tmp',
        reason: null,
        risk: null,
        parsedCmd: [],
      },
    }) + '\n');

    await new Promise((resolve) => setTimeout(resolve, 10));

    const payloads = writes
      .join('')
      .split(/\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id?: number; result?: Record<string, unknown> });

    const response = payloads.find((payload) => payload.id === 77);
    expect(response?.result).toEqual({ decision: 'approved_for_session' });

    await client.stop();
  });

  it('responds to server approval requests that use string ids', async () => {
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

    fake.stdout.write(JSON.stringify({
      id: 'approval-77',
      method: 'execCommandApproval',
      params: {
        conversationId: 'conv-1',
        callId: 'call-1',
        command: ['echo', 'hello'],
        cwd: '/tmp',
        reason: null,
        risk: null,
        parsedCmd: [],
      },
    }) + '\n');

    await new Promise((resolve) => setTimeout(resolve, 10));

    const payloads = writes
      .join('')
      .split(/\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id?: number | string; result?: Record<string, unknown> });

    const response = payloads.find((payload) => payload.id === 'approval-77');
    expect(response?.result).toMatchObject({ decision: 'approved' });

    await client.stop();
  });

  it('auto-approves unknown approval method variants', async () => {
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

    fake.stdout.write(JSON.stringify({
      id: 88,
      method: 'patch_apply_approval',
      params: {
        call_id: 'call-1',
      },
    }) + '\n');

    await new Promise((resolve) => setTimeout(resolve, 10));

    const payloads = writes
      .join('')
      .split(/\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id?: number | string; result?: Record<string, unknown> });

    const response = payloads.find((payload) => payload.id === 88);
    expect(response?.result).toMatchObject({ decision: 'approved' });

    await client.stop();
  });

  it('auto-approves requestApproval method variants with accept decision format', async () => {
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

    fake.stdout.write(JSON.stringify({
      id: 89,
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'call-1',
        reason: null,
        grantRoot: null,
      },
    }) + '\n');

    await new Promise((resolve) => setTimeout(resolve, 10));

    const payloads = writes
      .join('')
      .split(/\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id?: number | string; result?: Record<string, unknown> });

    const response = payloads.find((payload) => payload.id === 89);
    expect(response?.result).toMatchObject({ decision: 'accept' });

    await client.stop();
  });

  it('treats id+method payloads as server requests even with extraneous result/error keys', async () => {
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

    fake.stdout.write(JSON.stringify({
      id: 'approval-extra-fields',
      method: 'applyPatchApproval',
      params: {
        conversationId: 'conv-1',
        callId: 'call-1',
        fileChanges: {},
      },
      result: null,
      error: null,
    }) + '\n');

    await new Promise((resolve) => setTimeout(resolve, 10));

    const payloads = writes
      .join('')
      .split(/\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id?: number | string; result?: Record<string, unknown> });

    const response = payloads.find((payload) => payload.id === 'approval-extra-fields');
    expect(response?.result).toMatchObject({ decision: 'approved' });

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

  it('recovers and retries initialize when stdin write fails due destroyed stream', async () => {
    const failing = new FakeChildProcess();
    const healthy = new FakeChildProcess();
    let spawnCount = 0;

    (failing as any).stdin = {
      destroyed: false,
      writable: true,
      writableEnded: false,
      write: (_chunk: string, callback?: (error?: Error | null) => void) => {
        queueMicrotask(() => {
          callback?.(new Error('Cannot call write after a stream was destroyed'));
        });
        return false;
      },
    };

    healthy.stdin.on('data', (chunk) => {
      const lines = String(chunk)
        .split(/\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        const payload = JSON.parse(line) as { id?: number; method: string };
        if (payload.method === 'initialize') {
          healthy.stdout.write(JSON.stringify({
            id: payload.id,
            result: { sessionId: 'ok' },
          }) + '\n');
        }
      }
    });

    const client = new CodexRpcClient({
      requestTimeoutMs: 2_000,
      spawnFactory: () => {
        spawnCount += 1;
        return spawnCount === 1 ? (failing as any) : (healthy as any);
      },
    });

    await client.ensureInitialized();
    expect(spawnCount).toBe(2);

    await client.stop();
  });
});
