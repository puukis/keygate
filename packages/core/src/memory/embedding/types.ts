/**
 * Embedding provider abstraction for vector memory search.
 */

export interface EmbeddingProvider {
  /** Provider identifier (e.g. 'openai', 'gemini', 'ollama', 'codex'). */
  readonly id: string;
  /** Model name used for embedding (e.g. 'text-embedding-3-small'). */
  readonly model: string;
  /** Dimensionality of the embedding vectors produced. */
  readonly dimensions: number;

  /** Embed a single query string. */
  embedQuery(text: string): Promise<number[]>;

  /** Embed multiple texts in a batch. Returns one vector per input. */
  embedBatch(texts: string[]): Promise<number[][]>;
}

export type MemoryProviderName = 'auto' | 'openai' | 'codex' | 'gemini' | 'ollama';

export interface MemoryConfig {
  provider: MemoryProviderName;
  model?: string;
  vectorWeight: number;
  textWeight: number;
  maxResults: number;
  minScore: number;
  autoIndex: boolean;
  indexSessions: boolean;
  temporalDecay: boolean;
  temporalHalfLifeDays: number;
  mmr: boolean;
}
