import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool, ToolResult } from '../../types.js';

/**
 * Read file contents
 */
export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read the contents of a file',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path to the file to read',
      },
    },
    required: ['path'],
  },
  requiresConfirmation: false,
  type: 'filesystem',
  handler: async (args): Promise<ToolResult> => {
    const filePath = args['path'] as string;
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return { success: true, output: content };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Failed to read file',
      };
    }
  },
};

/**
 * Write content to a file
 */
export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write content to a file. Creates the file and parent directories if they do not exist.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path to the file to write',
      },
      content: {
        type: 'string',
        description: 'The content to write to the file',
      },
    },
    required: ['path', 'content'],
  },
  requiresConfirmation: true,
  type: 'filesystem',
  handler: async (args): Promise<ToolResult> => {
    const filePath = args['path'] as string;
    const content = args['content'] as string;
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
      return { success: true, output: `File written: ${filePath}` };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Failed to write file',
      };
    }
  },
};

/**
 * List directory contents
 */
export const listDirectoryTool: Tool = {
  name: 'list_directory',
  description: 'List the contents of a directory',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path to the directory to list',
      },
    },
    required: ['path'],
  },
  requiresConfirmation: false,
  type: 'filesystem',
  handler: async (args): Promise<ToolResult> => {
    const dirPath = args['path'] as string;
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const formatted = entries.map(e => 
        `${e.isDirectory() ? '📁' : '📄'} ${e.name}`
      ).join('\n');
      return { success: true, output: formatted || '(empty directory)' };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Failed to list directory',
      };
    }
  },
};

/**
 * Delete a file
 */
export const deleteFileTool: Tool = {
  name: 'delete_file',
  description: 'Delete a file',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path to the file to delete',
      },
    },
    required: ['path'],
  },
  requiresConfirmation: true,
  type: 'filesystem',
  handler: async (args): Promise<ToolResult> => {
    const filePath = args['path'] as string;
    try {
      await fs.unlink(filePath);
      return { success: true, output: `File deleted: ${filePath}` };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Failed to delete file',
      };
    }
  },
};

/**
 * All filesystem tools
 */
export const filesystemTools: Tool[] = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  deleteFileTool,
];
