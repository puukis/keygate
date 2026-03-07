import type { Database } from '../db/index.js';
import type {
  KeygateConfig,
  LLMProviderName,
  LLMUsageSnapshot,
  SessionUsageAggregate,
} from '../types.js';
import { estimateCostUsd, resolvePricingOverride, roundUsd } from './pricing.js';

export type UsageWindow = '24h' | '7d' | '30d' | 'all';

export interface UsageSummaryBucket {
  key: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface UsageSummary {
  window: UsageWindow;
  generatedAt: string;
  total: UsageSummaryBucket;
  byProvider: UsageSummaryBucket[];
  byModel: UsageSummaryBucket[];
  bySession: UsageSummaryBucket[];
  byDay: UsageSummaryBucket[];
}

export class UsageService {
  constructor(
    private readonly db: Database,
    private readonly config: KeygateConfig,
  ) {}

  estimateUsageSnapshot(input: {
    provider: LLMProviderName | string;
    model: string;
    promptText: string;
    responseText: string;
    latencyMs?: number;
    cachedTokens?: number;
  }): LLMUsageSnapshot {
    const inputTokens = estimateTextTokens(input.promptText);
    const outputTokens = estimateTextTokens(input.responseText);
    const cachedTokens = Math.max(0, input.cachedTokens ?? 0);
    const pricing = resolvePricingOverride(this.config, input.provider, input.model);
    const costUsd = estimateCostUsd(pricing, inputTokens, outputTokens, cachedTokens);

    return {
      provider: input.provider,
      model: input.model,
      inputTokens,
      outputTokens,
      cachedTokens,
      totalTokens: inputTokens + outputTokens,
      latencyMs: input.latencyMs,
      costUsd,
      estimatedCost: costUsd !== undefined,
      source: 'estimated',
      raw: {
        estimator: 'chars_div_4',
      },
    };
  }

  normalizeUsageSnapshot(
    usage: LLMUsageSnapshot,
    fallback: {
      provider: LLMProviderName | string;
      model: string;
      promptText: string;
      responseText: string;
      latencyMs?: number;
    }
  ): LLMUsageSnapshot {
    const estimated = this.estimateUsageSnapshot(fallback);
    const hasFiniteInput = Number.isFinite(usage.inputTokens);
    const hasFiniteOutput = Number.isFinite(usage.outputTokens);
    const hasFiniteTotal = Number.isFinite(usage.totalTokens);
    const hasFiniteCached = Number.isFinite(usage.cachedTokens);
    const allExplicitCountsZero =
      (hasFiniteInput || hasFiniteOutput || hasFiniteTotal)
      && sanitizeCount(usage.inputTokens, 0) === 0
      && sanitizeCount(usage.outputTokens, 0) === 0
      && sanitizeCount(usage.totalTokens, 0) === 0;
    const useEstimatedCounts = allExplicitCountsZero || (!hasFiniteInput && !hasFiniteOutput && !hasFiniteTotal);
    const inputTokens = useEstimatedCounts
      ? estimated.inputTokens
      : sanitizeCount(usage.inputTokens, estimated.inputTokens);
    const outputTokens = useEstimatedCounts
      ? estimated.outputTokens
      : sanitizeCount(usage.outputTokens, estimated.outputTokens);
    const cachedTokens = useEstimatedCounts && !hasFiniteCached
      ? estimated.cachedTokens
      : sanitizeCount(usage.cachedTokens, 0);
    const totalTokens = useEstimatedCounts
      ? estimated.totalTokens
      : sanitizeCount(usage.totalTokens, inputTokens + outputTokens);
    const pricing = resolvePricingOverride(
      this.config,
      usage.provider || fallback.provider,
      usage.model || fallback.model
    );
    const costUsd = usage.costUsd ?? estimateCostUsd(pricing, inputTokens, outputTokens, cachedTokens);
    const nativeCountsPresent =
      !useEstimatedCounts
      && (
        hasFiniteInput
        || hasFiniteOutput
        || hasFiniteTotal
      );

    return {
      provider: usage.provider || fallback.provider,
      model: usage.model || fallback.model,
      inputTokens,
      outputTokens,
      cachedTokens,
      totalTokens,
      latencyMs: usage.latencyMs ?? fallback.latencyMs,
      costUsd,
      estimatedCost: usage.costUsd === undefined,
      source: usage.source ?? (nativeCountsPresent ? 'native' : 'estimated'),
      raw: usage.raw,
    };
  }

  recordTurnUsage(sessionId: string, usage: LLMUsageSnapshot): SessionUsageAggregate {
    return this.db.recordMessageUsage(sessionId, usage);
  }

  summarize(options: { sessionId?: string; window?: UsageWindow } = {}): UsageSummary {
    const window = options.window ?? 'all';
    const createdAfter = resolveWindowStart(window);
    const rows = this.db.listMessageUsage({
      sessionId: options.sessionId,
      createdAfter: createdAfter ?? undefined,
    });

    const total = createEmptyBucket('total');
    const byProvider = new Map<string, UsageSummaryBucket>();
    const byModel = new Map<string, UsageSummaryBucket>();
    const bySession = new Map<string, UsageSummaryBucket>();
    const byDay = new Map<string, UsageSummaryBucket>();

    for (const row of rows) {
      addUsageToBucket(total, row);
      addUsageToBucket(getOrCreateBucket(byProvider, row.provider), row);
      addUsageToBucket(getOrCreateBucket(byModel, row.model), row);
      addUsageToBucket(getOrCreateBucket(bySession, row.sessionId), row);
      addUsageToBucket(getOrCreateBucket(byDay, row.createdAt.slice(0, 10)), row);
    }

    return {
      window,
      generatedAt: new Date().toISOString(),
      total,
      byProvider: sortBuckets(byProvider),
      byModel: sortBuckets(byModel),
      bySession: sortBuckets(bySession),
      byDay: Array.from(byDay.values()).sort((left, right) => right.key.localeCompare(left.key)),
    };
  }
}

function estimateTextTokens(value: string): number {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function sanitizeCount(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : fallback;
}

function createEmptyBucket(key: string): UsageSummaryBucket {
  return {
    key,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

function getOrCreateBucket(
  buckets: Map<string, UsageSummaryBucket>,
  key: string
): UsageSummaryBucket {
  const existing = buckets.get(key);
  if (existing) {
    return existing;
  }

  const created = createEmptyBucket(key);
  buckets.set(key, created);
  return created;
}

function addUsageToBucket(
  bucket: UsageSummaryBucket,
  row: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    totalTokens: number;
    costUsd?: number;
  }
): void {
  bucket.turns += 1;
  bucket.inputTokens += row.inputTokens;
  bucket.outputTokens += row.outputTokens;
  bucket.cachedTokens += row.cachedTokens;
  bucket.totalTokens += row.totalTokens;
  bucket.costUsd = roundUsd(bucket.costUsd + (row.costUsd ?? 0));
}

function sortBuckets(map: Map<string, UsageSummaryBucket>): UsageSummaryBucket[] {
  return Array.from(map.values()).sort((left, right) => {
    if (right.costUsd !== left.costUsd) {
      return right.costUsd - left.costUsd;
    }
    if (right.totalTokens !== left.totalTokens) {
      return right.totalTokens - left.totalTokens;
    }
    return left.key.localeCompare(right.key);
  });
}

function resolveWindowStart(window: UsageWindow): string | null {
  if (window === 'all') {
    return null;
  }

  const now = Date.now();
  const hours =
    window === '24h'
      ? 24
      : window === '7d'
        ? 24 * 7
        : 24 * 30;
  return new Date(now - (hours * 60 * 60 * 1000)).toISOString();
}
