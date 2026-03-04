import path from 'node:path';
import { promises as fs } from 'node:fs';
import { resolveWorkspacePath } from './agentWorkspace.js';

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
