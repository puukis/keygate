import type { Tool, ToolResult } from '../../types.js';
import { loadRegistry, searchMarketplace } from '../../skills/marketplace.js';
import { resolveSourceDirectory, discoverSkillDirs, installSkillsFromSource } from '../../skills/install.js';
import { SkillsManager } from '../../skills/manager.js';
import { loadConfigFromEnv } from '../../config/env.js';
import * as path from 'node:path';

export const marketplaceSearchTool: Tool = {
  name: 'marketplace_search',
  description: 'Search the Keygate skills marketplace for available skills. This should be used to find skills for the user.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query (name, description, tags, author). Leave empty to list featured skills.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional array of tags to filter by.',
      },
      limit: {
        type: 'number',
        description: 'Optional maximum number of results to return (default: 10).',
      },
    },
    required: ['query'],
  },
  requiresConfirmation: false,
  type: 'other',
  handler: async (args): Promise<ToolResult> => {
    const query = (args['query'] as string) ?? '';
    const tags = (args['tags'] as string[]) ?? [];
    const limit = (args['limit'] as number) ?? 10;

    try {
      const registry = await loadRegistry();
      const result = searchMarketplace(registry, query, { tags, limit });

      if (result.entries.length === 0) {
        return {
          success: true,
          output: 'No skills found matching your query.',
        };
      }

      let output = `Found ${result.total} skill(s):\n\n`;
      for (const entry of result.entries) {
        const badge = entry.featured ? ' ★' : '';
        const tagStr = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
        output += `### ${entry.name}${badge}\n`;
        output += `**Description**: ${entry.description}${tagStr}\n`;
        output += `**Author**: ${entry.author} | **Downloads**: ${entry.downloads}\n`;
        output += `**Source**: \`${entry.source}\`\n\n`;
      }

      return { success: true, output };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Marketplace search failed',
      };
    }
  },
};

export const skillInstallTool: Tool = {
  name: 'skill_install',
  description: 'Install a skill from a local path or Git repository URL (often discovered via marketplace_search). Once installed, the skill is automatically hot-reloaded and available within seconds.',
  parameters: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'The source path (e.g., local absolute directory or https:// github repo URL).',
      },
      targetName: {
        type: 'string',
        description: 'The explicit name of the skill to extract from the source if it contains multiple skills. Leave empty if the source is a single skill.',
      },
      scope: {
        type: 'string',
        enum: ['workspace', 'global'],
        description: 'The installation scope. Default is "workspace" which applies to the current project only.',
      },
    },
    required: ['source'],
  },
  requiresConfirmation: true,
  type: 'other',
  handler: async (args): Promise<ToolResult> => {
    const source = args['source'] as string;
    const targetName = (args['targetName'] as string) ?? '';
    const scope = (args['scope'] as 'workspace' | 'global') ?? 'workspace';

    try {
      // We start an ephemeral manager purely to execute the installation logic
      const config = loadConfigFromEnv();
      const manager = new SkillsManager({ config });
      
      const installed = await installSkillsFromSource(manager, {
        source,
        scope,
        targetName,
        installAll: false,
      });

      if (installed.length === 0) {
        return {
          success: false,
          output: '',
          error: 'No skills installed. Check source path and targetName.',
        };
      }

      return {
        success: true,
        output: `Successfully installed skill(s): ${installed.join(', ')}. The background Gateway will automatically detect and load these skills momentarily.`,
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Skill installation failed',
      };
    }
  },
};

export const marketplaceTools: Tool[] = [
  marketplaceSearchTool,
  skillInstallTool,
];
