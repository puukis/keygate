import type { Tool, ToolResult } from '../../types.js';

// Note: This is a placeholder implementation. In production, you'd use
// Tavily API (https://tavily.com/) or SerpAPI for real web search.

/**
 * Web search tool (placeholder - requires API key)
 */
export const webSearchTool: Tool = {
  name: 'web_search',
  description: 'Search the web for information. Returns relevant snippets from web pages.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      numResults: {
        type: 'number',
        description: 'Number of results to return (default: 5)',
      },
    },
    required: ['query'],
  },
  requiresConfirmation: false,
  type: 'other',
  handler: async (args): Promise<ToolResult> => {
    const query = args['query'] as string;
    const numResults = (args['numResults'] as number) ?? 5;
    
    // Check for Tavily API key
    const tavilyKey = process.env['TAVILY_API_KEY'];
    
    if (!tavilyKey) {
      return {
        success: false,
        output: '',
        error: 'Web search requires TAVILY_API_KEY to be set. Get one at https://tavily.com/',
      };
    }

    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: tavilyKey,
          query,
          max_results: numResults,
          include_answer: true,
        }),
      });

      if (!response.ok) {
        throw new Error(`Tavily API error: ${response.status}`);
      }

      const data = await response.json() as {
        answer?: string;
        results: Array<{
          title: string;
          url: string;
          content: string;
        }>;
      };

      let output = '';
      
      if (data.answer) {
        output += `**Summary:** ${data.answer}\n\n`;
      }

      output += '**Sources:**\n';
      for (const result of data.results) {
        output += `\n### ${result.title}\n`;
        output += `URL: ${result.url}\n`;
        output += `${result.content}\n`;
      }

      return { success: true, output };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Web search failed',
      };
    }
  },
};

export const searchTools: Tool[] = [webSearchTool];
