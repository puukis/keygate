import type { Tool, ToolResult } from '../../types.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadConfigFromEnv } from '../../config/env.js';
import { getMemorySnippet } from '../../workspace/memoryRecall.js';

export const memorySearchTool: Tool = {
  name: 'memory_search',
  description: 'Semantic search across memory files (MEMORY.md, memory/*.md) and past session transcripts. Uses vector embeddings for meaning-based retrieval.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language query to search in memory.',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of snippets to return (default: 6, max: 20).',
      },
      minScore: {
        type: 'number',
        description: 'Minimum similarity score from 0 to 1 (default: 0.35).',
      },
      source: {
        type: 'string',
        description: 'Filter by source: "memory" (workspace files), "session" (past conversations), or "all" (default).',
        enum: ['memory', 'session', 'all'],
      },
    },
    required: ['query'],
  },
  requiresConfirmation: false,
  type: 'other',
  handler: async (args): Promise<ToolResult> => {
    const query = typeof args['query'] === 'string' ? args['query'] : '';
    const maxResults = typeof args['maxResults'] === 'number' ? args['maxResults'] : undefined;
    const minScore = typeof args['minScore'] === 'number' ? args['minScore'] : undefined;
    const source = typeof args['source'] === 'string' ? args['source'] as 'memory' | 'session' | 'all' : 'all';

    if (!query.trim()) {
      return { success: false, output: '', error: 'query is required' };
    }

    try {
      const { Gateway } = await import('../../gateway/Gateway.js');
      const gateway = Gateway.peekInstance();
      if (!gateway) {
        const fallbackResults = await searchMemoryFallback(
          loadConfigFromEnv().security.workspacePath,
          query,
          {
            maxResults,
            minScore,
            source,
          }
        );
        return {
          success: true,
          output: JSON.stringify({ results: fallbackResults }, null, 2),
        };
      }

      const results = await gateway.memoryManager.search(query, {
        maxResults,
        minScore,
        source,
      });

      return {
        success: true,
        output: JSON.stringify({ results }, null, 2),
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'memory_search failed',
      };
    }
  },
};

export const memoryGetTool: Tool = {
  name: 'memory_get',
  description: 'Read a line-limited snippet from MEMORY.md or memory/*.md.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative memory path (MEMORY.md or memory/<file>.md).',
      },
      from: {
        type: 'number',
        description: '1-based starting line number (default: 1).',
      },
      lines: {
        type: 'number',
        description: 'Maximum lines to read (default: 50, max: 500).',
      },
    },
    required: ['path'],
  },
  requiresConfirmation: false,
  type: 'other',
  handler: async (args): Promise<ToolResult> => {
    const filePath = typeof args['path'] === 'string' ? args['path'] : '';
    const from = typeof args['from'] === 'number' ? args['from'] : undefined;
    const lines = typeof args['lines'] === 'number' ? args['lines'] : undefined;

    if (!filePath.trim()) {
      return { success: false, output: '', error: 'path is required' };
    }

    try {
      const config = loadConfigFromEnv();
      const snippet = await getMemorySnippet({
        workspacePath: config.security.workspacePath,
        filePath,
        from,
        lines,
      });

      return {
        success: true,
        output: JSON.stringify(snippet, null, 2),
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'memory_get failed',
      };
    }
  },
};

export const memoryTools: Tool[] = [memorySearchTool, memoryGetTool];

async function searchMemoryFallback(
  workspacePath: string,
  query: string,
  options: {
    maxResults?: number;
    minScore?: number;
    source: 'memory' | 'session' | 'all';
  }
): Promise<Array<{
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: 'memory';
}>> {
  if (options.source === 'session') {
    return [];
  }

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
  if (terms.length === 0) {
    return [];
  }

  const candidates = await listMemoryFiles(workspacePath);
  const matches: Array<{
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    source: 'memory';
  }> = [];

  for (const relativePath of candidates) {
    const absolutePath = path.join(workspacePath, relativePath);
    let raw = '';
    try {
      raw = await fs.readFile(absolutePath, 'utf8');
    } catch {
      continue;
    }

    const lines = raw.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const normalized = line.toLowerCase();
      const hits = terms.filter((term) => normalized.includes(term)).length;
      if (hits === 0) {
        continue;
      }

      const score = hits / terms.length;
      matches.push({
        path: relativePath,
        startLine: index + 1,
        endLine: index + 1,
        score: Number(score.toFixed(4)),
        snippet: line.slice(0, 700),
        source: 'memory',
      });
    }
  }

  const minScore = options.minScore ?? 0;
  const maxResults = Math.max(1, Math.min(20, options.maxResults ?? 6));
  return matches
    .filter((match) => match.score >= minScore)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (left.path !== right.path) {
        return left.path.localeCompare(right.path);
      }
      return left.startLine - right.startLine;
    })
    .slice(0, maxResults);
}

async function listMemoryFiles(workspacePath: string): Promise<string[]> {
  const files = ['MEMORY.md'];
  const memoryDir = path.join(workspacePath, 'memory');
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(`memory/${entry.name}`);
      }
    }
  } catch {
    // Ignore missing memory directory in fallback mode.
  }
  return files;
}
