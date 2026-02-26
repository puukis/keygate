export interface CronSchedule {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
}

const FIELD_RANGES = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 6 },
} as const;

export function parseCronExpression(expression: string): CronSchedule {
  const trimmed = expression.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error('Cron expression must have 5 fields: minute hour day-of-month month day-of-week');
  }

  const [minute, hour, dom, month, dow] = parts;

  return {
    minute: parseField(minute!, FIELD_RANGES.minute.min, FIELD_RANGES.minute.max, false),
    hour: parseField(hour!, FIELD_RANGES.hour.min, FIELD_RANGES.hour.max, false),
    dayOfMonth: parseField(dom!, FIELD_RANGES.dayOfMonth.min, FIELD_RANGES.dayOfMonth.max, false),
    month: parseField(month!, FIELD_RANGES.month.min, FIELD_RANGES.month.max, false),
    dayOfWeek: parseField(dow!, FIELD_RANGES.dayOfWeek.min, FIELD_RANGES.dayOfWeek.max, true),
    anyDayOfMonth: dom === '*',
    anyDayOfWeek: dow === '*',
  };
}

export function computeNextRunAt(expression: string, fromDate = new Date()): Date {
  const schedule = parseCronExpression(expression);
  const probe = new Date(fromDate);
  probe.setSeconds(0, 0);
  probe.setMinutes(probe.getMinutes() + 1);

  const maxIterations = 60 * 24 * 366; // 1 year
  for (let i = 0; i < maxIterations; i += 1) {
    if (matchesSchedule(probe, schedule)) {
      return new Date(probe);
    }
    probe.setMinutes(probe.getMinutes() + 1);
  }

  throw new Error('Unable to compute next run time for cron expression');
}

export function matchesSchedule(date: Date, schedule: CronSchedule): boolean {
  if (!schedule.minute.has(date.getMinutes())) return false;
  if (!schedule.hour.has(date.getHours())) return false;
  if (!schedule.month.has(date.getMonth() + 1)) return false;

  const domMatch = schedule.dayOfMonth.has(date.getDate());
  const dowMatch = schedule.dayOfWeek.has(date.getDay());

  if (!schedule.anyDayOfMonth && !schedule.anyDayOfWeek) {
    if (!domMatch && !dowMatch) return false;
  } else {
    if (!schedule.anyDayOfMonth && !domMatch) return false;
    if (!schedule.anyDayOfWeek && !dowMatch) return false;
  }

  return true;
}

function parseField(raw: string, min: number, max: number, allowWeekdaySeven: boolean): Set<number> {
  const out = new Set<number>();
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`Invalid cron field: ${raw}`);
  }

  for (const part of parts) {
    if (part === '*') {
      for (let value = min; value <= max; value += 1) {
        out.add(value);
      }
      continue;
    }

    const stepMatch = part.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = Number.parseInt(stepMatch[1]!, 10);
      if (!Number.isFinite(step) || step <= 0) {
        throw new Error(`Invalid cron step: ${part}`);
      }
      for (let value = min; value <= max; value += step) {
        out.add(value);
      }
      continue;
    }

    const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeMatch) {
      const start = normalizeWeekday(Number.parseInt(rangeMatch[1]!, 10), allowWeekdaySeven);
      const end = normalizeWeekday(Number.parseInt(rangeMatch[2]!, 10), allowWeekdaySeven);
      const step = rangeMatch[3] ? Number.parseInt(rangeMatch[3], 10) : 1;
      if (start > end || step <= 0) {
        throw new Error(`Invalid cron range: ${part}`);
      }
      assertInRange(start, min, max, part);
      assertInRange(end, min, max, part);
      for (let value = start; value <= end; value += step) {
        out.add(value);
      }
      continue;
    }

    const numeric = normalizeWeekday(Number.parseInt(part, 10), allowWeekdaySeven);
    if (!Number.isFinite(numeric)) {
      throw new Error(`Invalid cron value: ${part}`);
    }
    assertInRange(numeric, min, max, part);
    out.add(numeric);
  }

  if (out.size === 0) {
    throw new Error(`Cron field produced no values: ${raw}`);
  }

  return out;
}

function normalizeWeekday(value: number, allowWeekdaySeven: boolean): number {
  if (allowWeekdaySeven && value === 7) {
    return 0;
  }
  return value;
}

function assertInRange(value: number, min: number, max: number, source: string): void {
  if (value < min || value > max) {
    throw new Error(`Cron value out of range (${source}): expected ${min}-${max}`);
  }
}
