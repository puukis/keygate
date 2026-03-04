import { createHash } from 'node:crypto';

export interface Chunk {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

const DEFAULT_CHUNK_TOKENS = 400;
const DEFAULT_OVERLAP_TOKENS = 80;

/**
 * Rough token estimate: ~0.75 words per token.
 * This avoids a tokenizer dependency while being close enough for chunking decisions.
 */
function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words / 0.75);
}

/**
 * Split file content into overlapping chunks of approximately `chunkTokens` tokens.
 *
 * Works on lines to preserve line-number alignment for retrieval.
 */
export function chunkText(
  filePath: string,
  content: string,
  chunkTokens = DEFAULT_CHUNK_TOKENS,
  overlapTokens = DEFAULT_OVERLAP_TOKENS,
): Chunk[] {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) return [];

  // If the whole file fits in one chunk, return it as-is
  if (estimateTokens(content) <= chunkTokens) {
    const text = content.trim();
    if (!text) return [];
    return [
      {
        id: chunkId(filePath, 1, lines.length),
        path: filePath,
        startLine: 1,
        endLine: lines.length,
        text,
      },
    ];
  }

  const chunks: Chunk[] = [];
  let start = 0;

  while (start < lines.length) {
    // Determine how many lines fit in the token budget
    let end = start;
    let tokenCount = 0;

    while (end < lines.length) {
      const lineTokens = estimateTokens(lines[end]!);
      if (tokenCount + lineTokens > chunkTokens && end > start) {
        break;
      }
      tokenCount += lineTokens;
      end++;
    }

    const text = lines.slice(start, end).join('\n').trim();
    if (text) {
      chunks.push({
        id: chunkId(filePath, start + 1, end),
        path: filePath,
        startLine: start + 1,
        endLine: end,
        text,
      });
    }

    if (end >= lines.length) break;

    // Move forward by (chunk size - overlap), in lines
    // Calculate how many lines correspond to the overlap
    let overlapLines = 0;
    let overlapCount = 0;
    for (let i = end - 1; i >= start && overlapCount < overlapTokens; i--) {
      overlapCount += estimateTokens(lines[i]!);
      overlapLines++;
    }

    start = end - overlapLines;
    if (start <= (chunks.length > 0 ? chunks[chunks.length - 1]!.startLine - 1 : 0)) {
      // Prevent infinite loop — always advance at least one line
      start = end;
    }
  }

  return chunks;
}

/**
 * Chunk session transcript messages into context windows.
 * Groups consecutive user+assistant turns together.
 */
export function chunkSessionMessages(
  sessionId: string,
  messages: Array<{ role: string; content: string }>,
  chunkTokens = DEFAULT_CHUNK_TOKENS,
): Chunk[] {
  if (messages.length === 0) return [];

  const chunks: Chunk[] = [];
  let buffer = '';
  let bufferStart = 1;
  let lineIndex = 1;

  for (const msg of messages) {
    const line = `[${msg.role}]: ${msg.content}`;
    const combined = buffer ? `${buffer}\n${line}` : line;

    if (estimateTokens(combined) > chunkTokens && buffer) {
      const text = buffer.trim();
      if (text) {
        chunks.push({
          id: chunkId(`session:${sessionId}`, bufferStart, lineIndex - 1),
          path: `session:${sessionId}`,
          startLine: bufferStart,
          endLine: lineIndex - 1,
          text,
        });
      }
      buffer = line;
      bufferStart = lineIndex;
    } else {
      buffer = combined;
    }
    lineIndex++;
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    chunks.push({
      id: chunkId(`session:${sessionId}`, bufferStart, lineIndex - 1),
      path: `session:${sessionId}`,
      startLine: bufferStart,
      endLine: lineIndex - 1,
      text: buffer.trim(),
    });
  }

  return chunks;
}

function chunkId(path: string, startLine: number, endLine: number): string {
  return createHash('sha256')
    .update(`${path}:${startLine}:${endLine}`)
    .digest('hex')
    .slice(0, 16);
}
