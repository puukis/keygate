import type { Tool, ToolResult } from '../../types.js';
import { loadConfigFromEnv } from '../../config/env.js';
import { getMemorySnippet, searchMemoryFiles } from '../../workspace/memoryRecall.js';

export const memorySearchTool: Tool = {
  name: 'memory_search',
  description: 'Search MEMORY.md and memory/*.md semantically and return top snippets with path and line ranges.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language query to search in memory files.',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of snippets to return (default: 5, max: 20).',
      },
      minScore: {
        type: 'number',
        description: 'Minimum similarity score from 0 to 1 (default: 0.08).',
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

    if (!query.trim()) {
      return { success: false, output: '', error: 'query is required' };
    }

    try {
      const config = loadConfigFromEnv();
      const result = await searchMemoryFiles({
        workspacePath: config.security.workspacePath,
        query,
        maxResults,
        minScore,
      });

      return {
        success: true,
        output: JSON.stringify(result, null, 2),
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
