import { describe, expect, it } from 'vitest';
import { computeNextRunAt, parseCronExpression } from '../cron.js';

describe('scheduler cron parser', () => {
  it('parses wildcard and step expressions', () => {
    const schedule = parseCronExpression('*/15 * * * *');
    expect(schedule.minute.has(0)).toBe(true);
    expect(schedule.minute.has(15)).toBe(true);
    expect(schedule.minute.has(45)).toBe(true);
    expect(schedule.minute.has(14)).toBe(false);
  });

  it('computes next run from a reference date', () => {
    const next = computeNextRunAt('30 10 * * *', new Date(2026, 1, 25, 10, 5, 0, 0));
    expect(next.getHours()).toBe(10);
    expect(next.getMinutes()).toBe(30);
    expect(next.getDate()).toBe(25);
  });

  it('supports day-of-week alias 7 as sunday', () => {
    const next = computeNextRunAt('0 0 * * 7', new Date(2026, 1, 25, 10, 5, 0, 0));
    expect(next.getDay()).toBe(0);
  });
});
