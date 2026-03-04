import { GoogleGenerativeAI } from '@google/generative-ai';
import type { EmbeddingProvider } from './types.js';

const DEFAULT_MODEL = 'text-embedding-004';
const DIMENSIONS: Record<string, number> = {
  'text-embedding-004': 768,
  'embedding-001': 768,
};

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'gemini';
  readonly model: string;
  readonly dimensions: number;
  private client: GoogleGenerativeAI;

  constructor(apiKey: string, model?: string) {
    this.model = model ?? DEFAULT_MODEL;
    this.dimensions = DIMENSIONS[this.model] ?? 768;
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async embedQuery(text: string): Promise<number[]> {
    const model = this.client.getGenerativeModel({ model: this.model });
    const result = await model.embedContent(text);
    return result.embedding.values;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const model = this.client.getGenerativeModel({ model: this.model });
    const result = await model.batchEmbedContents({
      requests: texts.map((text) => ({
        content: { role: 'user', parts: [{ text }] },
      })),
    });
    return result.embeddings.map((e) => e.values);
  }
}
