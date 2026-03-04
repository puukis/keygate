import OpenAI from 'openai';
import type { EmbeddingProvider } from './types.js';

const DEFAULT_MODEL = 'text-embedding-3-small';
const DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai';
  readonly model: string;
  readonly dimensions: number;
  private client: OpenAI;

  constructor(apiKey: string, model?: string) {
    this.model = model ?? DEFAULT_MODEL;
    this.dimensions = DIMENSIONS[this.model] ?? 1536;
    this.client = new OpenAI({ apiKey });
  }

  async embedQuery(text: string): Promise<number[]> {
    const res = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    return res.data[0]!.embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });
    return res.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}
