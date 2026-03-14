import type { VectorStore, VectorSearchResult } from './vectorStore.js';
import type { EmbeddingProvider } from './embedding/types.js';
import type { MemoryConfig } from './embedding/types.js';

export interface MemorySearchOptions {
  maxResults?: number;
  minScore?: number;
  source?: 'memory' | 'session' | 'all';
  vectorWeight?: number;
  textWeight?: number;
  temporalDecay?: boolean;
  temporalHalfLifeDays?: number;
  mmr?: boolean;
}

export interface MemorySearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: 'memory' | 'session';
}

/**
 * Hybrid semantic + keyword search over the vector store.
 *
 * Pipeline:
 * 1. Embed query → vector search (cosine similarity)
 * 2. Keyword search (BM25 via FTS5)
 * 3. Merge & score: finalScore = vectorWeight × vectorScore + textWeight × textScore
 * 4. Optional temporal decay (exponential, based on file dates)
 * 5. Optional MMR reranking (diversity-aware)
 * 6. Filter by minScore, return top maxResults
 */
export async function searchMemory(
  query: string,
  provider: EmbeddingProvider,
  store: VectorStore,
  config: MemoryConfig,
  opts: MemorySearchOptions = {},
): Promise<MemorySearchResult[]> {
  const maxResults = opts.maxResults ?? config.maxResults;
  const minScore = opts.minScore ?? config.minScore;
  const vectorWeight = opts.vectorWeight ?? config.vectorWeight;
  const textWeight = opts.textWeight ?? config.textWeight;
  const useTemporalDecay = opts.temporalDecay ?? config.temporalDecay;
  const halfLifeDays = opts.temporalHalfLifeDays ?? config.temporalHalfLifeDays;
  const useMmr = opts.mmr ?? config.mmr;
  const sourceFilter = opts.source === 'all' ? undefined : opts.source;

  // Fetch 3x candidates for reranking headroom
  const candidateLimit = maxResults * 3;

  // 1. Vector search
  const queryEmbedding = await provider.embedQuery(query);
  const vectorResults = await store.vectorSearch(queryEmbedding, {
    limit: candidateLimit,
    source: sourceFilter,
  });

  // 2. Keyword search
  const keywordResults = store.keywordSearch(query, {
    limit: candidateLimit,
    source: sourceFilter,
  });

  // 3. Merge results
  let merged = mergeHybridResults(vectorResults, keywordResults, vectorWeight, textWeight);

  // 4. Temporal decay
  if (useTemporalDecay) {
    merged = applyTemporalDecay(merged, halfLifeDays);
  }

  // 5. MMR reranking
  if (useMmr) {
    merged = applyMmr(merged, maxResults, 0.7);
  }

  // 6. Filter and limit
  return merged
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((r) => ({
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      score: Number(r.score.toFixed(4)),
      snippet: r.text.slice(0, 700),
      source: r.source,
    }));
}

// ── Merge ─────────────────────────────────────────────────────

interface MergedResult extends VectorSearchResult {
  vectorScore: number;
  textScore: number;
}

function mergeHybridResults(
  vectorResults: VectorSearchResult[],
  keywordResults: VectorSearchResult[],
  vectorWeight: number,
  textWeight: number,
): MergedResult[] {
  const map = new Map<string, MergedResult>();

  for (const r of vectorResults) {
    map.set(r.id, {
      ...r,
      vectorScore: r.score,
      textScore: 0,
      score: vectorWeight * r.score,
    });
  }

  for (const r of keywordResults) {
    const existing = map.get(r.id);
    if (existing) {
      existing.textScore = r.score;
      existing.score = vectorWeight * existing.vectorScore + textWeight * r.score;
    } else {
      map.set(r.id, {
        ...r,
        vectorScore: 0,
        textScore: r.score,
        score: textWeight * r.score,
      });
    }
  }

  return Array.from(map.values());
}

// ── Temporal Decay ──────────────────────────────────────────────

function applyTemporalDecay(results: MergedResult[], halfLifeDays: number): MergedResult[] {
  const lambda = Math.LN2 / halfLifeDays;
  const now = Date.now();

  return results.map((r) => {
    const fileDate = extractDateFromPath(r.path);
    if (!fileDate) return r; // evergreen files (MEMORY.md) get no decay

    const ageMs = now - fileDate.getTime();
    const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
    const decayFactor = Math.exp(-lambda * ageDays);

    return { ...r, score: r.score * decayFactor };
  });
}

/**
 * Extract date from paths like `memory/2026-03-04.md`.
 * Returns null for undated files (MEMORY.md, session paths, etc.).
 */
function extractDateFromPath(filePath: string): Date | null {
  const match = filePath.match(/(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  const parsed = new Date(match[1]!);
  return isNaN(parsed.getTime()) ? null : parsed;
}

// ── MMR (Maximal Marginal Relevance) ─────────────────────────

function applyMmr(results: MergedResult[], k: number, lambda: number): MergedResult[] {
  if (results.length <= 1) return results;

  const sorted = [...results].sort((a, b) => b.score - a.score);
  const selected: MergedResult[] = [];
  const remaining = new Set(sorted.map((_, i) => i));

  // Always pick the top-scoring result first
  selected.push(sorted[0]!);
  remaining.delete(0);

  while (selected.length < k && remaining.size > 0) {
    let bestIdx = -1;
    let bestMmrScore = -Infinity;

    for (const idx of remaining) {
      const candidate = sorted[idx]!;
      const relevance = candidate.score;

      // Max similarity to any already-selected result (using Jaccard on tokens)
      let maxSimilarity = 0;
      for (const sel of selected) {
        const sim = jaccardSimilarity(candidate.text, sel.text);
        if (sim > maxSimilarity) maxSimilarity = sim;
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarity;
      if (mmrScore > bestMmrScore) {
        bestMmrScore = mmrScore;
        bestIdx = idx;
      }
    }

    if (bestIdx < 0) break;
    selected.push(sorted[bestIdx]!);
    remaining.delete(bestIdx);
  }

  return selected;
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
