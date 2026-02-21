import { describe, expect, it } from 'vitest';
import { ConcurrencyLimiter } from '../Brain.js';

describe('ConcurrencyLimiter', () => {
  it('runs tasks up to the concurrency limit in parallel', async () => {
    const limiter = new ConcurrencyLimiter(2);
    const running: number[] = [];
    let maxConcurrent = 0;

    const task = (id: number) =>
      limiter.run(async () => {
        running.push(id);
        maxConcurrent = Math.max(maxConcurrent, running.length);
        // Simulate async work
        await new Promise((r) => setTimeout(r, 20));
        running.splice(running.indexOf(id), 1);
        return id;
      });

    const results = await Promise.all([task(1), task(2), task(3), task(4)]);

    expect(results).toEqual([1, 2, 3, 4]);
    expect(maxConcurrent).toBe(2);
  });

  it('respects limit of 1 (sequential execution)', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const order: number[] = [];

    const task = (id: number) =>
      limiter.run(async () => {
        order.push(id);
        await new Promise((r) => setTimeout(r, 5));
        return id;
      });

    await Promise.all([task(1), task(2), task(3)]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('propagates errors without blocking subsequent tasks', async () => {
    const limiter = new ConcurrencyLimiter(2);
    const completed: number[] = [];

    const results = await Promise.allSettled([
      limiter.run(async () => {
        throw new Error('fail');
      }),
      limiter.run(async () => {
        await new Promise((r) => setTimeout(r, 5));
        completed.push(2);
        return 2;
      }),
      limiter.run(async () => {
        await new Promise((r) => setTimeout(r, 5));
        completed.push(3);
        return 3;
      }),
    ]);

    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
    expect(results[2].status).toBe('fulfilled');
    expect(completed).toEqual([2, 3]);
  });

  it('handles high concurrency limit gracefully', async () => {
    const limiter = new ConcurrencyLimiter(100);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        limiter.run(async () => i)
      )
    );

    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
