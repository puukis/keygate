import type { Tool, ToolResult } from '../../types.js';
import { loadConfigFromEnv } from '../../config/env.js';
import { getMemorySnippet } from '../../workspace/memoryRecall.js';
import { Gateway } from '../../gateway/Gateway.js';

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
      const gateway = Gateway.peekInstance();
      if (!gateway) {
        return { success: false, output: '', error: 'Gateway not initialized' };
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
