import path from 'node:path';
import { promises as fs } from 'node:fs';
import { resolveWorkspacePath } from './agentWorkspace.js';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'is', 'are', 'was', 'were', 'be', 'been',
  'of', 'to', 'in', 'on', 'for', 'with', 'as', 'at', 'by', 'from', 'that', 'this', 'it', 'its',
  'we', 'you', 'they', 'he', 'she', 'i', 'me', 'my', 'our', 'your', 'their', 'not', 'do', 'does',
]);

export interface MemorySearchItem {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

export interface MemorySearchResult {
  disabled: boolean;
  results: MemorySearchItem[];
}

interface Chunk {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  terms: string[];
}

export async function searchMemoryFiles(params: {
  workspacePath: string;
  query: string;
  maxResults?: number;
  minScore?: number;
}): Promise<MemorySearchResult> {
  const workspacePath = resolveWorkspacePath(params.workspacePath);
  const query = params.query.trim();
  const maxResults = Math.max(1, Math.min(20, params.maxResults ?? 5));
  const minScore = Math.max(0, Math.min(1, params.minScore ?? 0.08));

  if (!query) {
    return { disabled: false, results: [] };
  }

  const files = await listMemoryFiles(workspacePath);
  if (files.length === 0) {
    return { disabled: false, results: [] };
  }

  const chunks = await loadChunks(workspacePath, files);
  if (chunks.length === 0) {
    return { disabled: false, results: [] };
  }

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) {
    return { disabled: false, results: [] };
  }

  const scored = scoreChunks(chunks, queryTerms)
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((item) => ({
      path: item.path,
      startLine: item.startLine,
      endLine: item.endLine,
      score: Number(item.score.toFixed(4)),
      snippet: item.text,
    }));

  return { disabled: false, results: scored };
}

export async function getMemorySnippet(params: {
  workspacePath: string;
  filePath: string;
  from?: number;
  lines?: number;
}): Promise<{ path: string; from: number; to: number; content: string }> {
  const workspacePath = resolveWorkspacePath(params.workspacePath);
  const relative = normalizeMemoryRelativePath(params.filePath);
  const absolute = path.join(workspacePath, relative);

  const raw = await fs.readFile(absolute, 'utf8');
  const allLines = raw.split(/\r?\n/);

  const from = Math.max(1, params.from ?? 1);
  const lineCount = Math.max(1, Math.min(500, params.lines ?? 50));
  const to = Math.min(allLines.length, from + lineCount - 1);

  const content = allLines.slice(from - 1, to).join('\n');
  return { path: relative, from, to, content };
}

export function normalizeMemoryRelativePath(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, '/').trim();
  if (!normalized) {
    throw new Error('path is required');
  }

  if (normalized === 'MEMORY.md') {
    return normalized;
  }

  if (normalized.startsWith('memory/') && normalized.endsWith('.md') && !normalized.includes('..')) {
    return normalized;
  }

  throw new Error('path must be MEMORY.md or memory/*.md');
}

async function listMemoryFiles(workspacePath: string): Promise<string[]> {
  const files: string[] = [];

  try {
    await fs.access(path.join(workspacePath, 'MEMORY.md'));
    files.push('MEMORY.md');
  } catch {
    // ignore missing long-term file
  }

  try {
    const entries = await fs.readdir(path.join(workspacePath, 'memory'), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(`memory/${entry.name}`);
      }
    }
  } catch {
    // ignore missing memory dir
  }

  return files.sort();
}

async function loadChunks(workspacePath: string, files: string[]): Promise<Chunk[]> {
  const chunks: Chunk[] = [];

  for (const relative of files) {
    const absolute = path.join(workspacePath, relative);
    const raw = await fs.readFile(absolute, 'utf8');
    const lines = raw.split(/\r?\n/);

    const window = 12;
    const stride = 6;
    if (lines.length <= window) {
      const text = lines.join('\n').trim();
      if (text) {
        chunks.push({ path: relative, startLine: 1, endLine: lines.length, text, terms: tokenize(text) });
      }
      continue;
    }

    for (let start = 0; start < lines.length; start += stride) {
      const endExclusive = Math.min(lines.length, start + window);
      const text = lines.slice(start, endExclusive).join('\n').trim();
      if (!text) {
        continue;
      }

      chunks.push({
        path: relative,
        startLine: start + 1,
        endLine: endExclusive,
        text,
        terms: tokenize(text),
      });

      if (endExclusive >= lines.length) {
        break;
      }
    }
  }

  return chunks;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !STOP_WORDS.has(term));
}

function scoreChunks(chunks: Chunk[], queryTerms: string[]): Array<Chunk & { score: number }> {
  const df = new Map<string, number>();
  for (const chunk of chunks) {
    const uniqueTerms = new Set(chunk.terms);
    for (const term of uniqueTerms) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const docCount = chunks.length;

  const idf = (term: string): number => {
    const freq = df.get(term) ?? 0;
    return Math.log((1 + docCount) / (1 + freq)) + 1;
  };

  const queryVec = tfidf(queryTerms, idf);
  const queryNorm = vectorNorm(queryVec);
  if (queryNorm === 0) {
    return chunks.map((chunk) => ({ ...chunk, score: 0 }));
  }

  return chunks.map((chunk) => {
    const docVec = tfidf(chunk.terms, idf);
    const docNorm = vectorNorm(docVec);
    if (docNorm === 0) {
      return { ...chunk, score: 0 };
    }

    const dot = dotProduct(queryVec, docVec);
    const score = dot / (queryNorm * docNorm);
    return { ...chunk, score };
  });
}

function tfidf(terms: string[], idf: (term: string) => number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of terms) {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }

  const total = Math.max(1, terms.length);
  const vector = new Map<string, number>();
  for (const [term, count] of counts.entries()) {
    vector.set(term, (count / total) * idf(term));
  }

  return vector;
}

function vectorNorm(vec: Map<string, number>): number {
  let sum = 0;
  for (const value of vec.values()) {
    sum += value * value;
  }
  return Math.sqrt(sum);
}

function dotProduct(a: Map<string, number>, b: Map<string, number>): number {
  let sum = 0;
  for (const [term, value] of a.entries()) {
    sum += value * (b.get(term) ?? 0);
  }
  return sum;
}
