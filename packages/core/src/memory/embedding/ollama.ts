import { Ollama } from 'ollama';
import type { EmbeddingProvider } from './types.js';

const DEFAULT_MODEL = 'nomic-embed-text';
const DIMENSIONS: Record<string, number> = {
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
};

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'ollama';
  readonly model: string;
  readonly dimensions: number;
  private client: Ollama;

  constructor(model?: string, host?: string) {
    this.model = model ?? DEFAULT_MODEL;
    this.dimensions = DIMENSIONS[this.model] ?? 768;
    this.client = new Ollama({ host: host ?? 'http://127.0.0.1:11434' });
  }

  async embedQuery(text: string): Promise<number[]> {
    const res = await this.client.embed({ model: this.model, input: text });
    return res.embeddings[0]!;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Ollama supports batch via the input field
    const res = await this.client.embed({ model: this.model, input: texts });
    return res.embeddings;
  }
}
