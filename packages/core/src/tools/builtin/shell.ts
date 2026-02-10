import { spawn } from 'node:child_process';
import type { Tool, ToolResult } from '../../types.js';
import { buildToolProcessEnv } from '../../runtime/index.js';

/**
 * Execute a shell command
 */
export const shellTool: Tool = {
  name: 'run_command',
  description: 'Execute a shell command and return the output. In Safe Mode, only allowed commands can be run.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command to execute',
      },
      cwd: {
        type: 'string',
        description: 'The working directory for the command (optional)',
      },
    },
    required: ['command'],
  },
  requiresConfirmation: true,
  type: 'shell',
  handler: async (args): Promise<ToolResult> => {
    const command = args['command'] as string;
    const cwd = args['cwd'] as string | undefined;
    
    return new Promise((resolve) => {
      // Parse command into binary and args
      const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
      const binary = parts[0] ?? '';
      const cmdArgs = parts.slice(1).map(arg => arg.replace(/^"|"$/g, ''));

      const proc = spawn(binary, cmdArgs, {
        cwd,
        shell: false,
        env: buildToolProcessEnv(),
        timeout: 60000, // 60 second timeout
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({
            success: true,
            output: stdout || '(no output)',
          });
        } else {
          resolve({
            success: false,
            output: stdout,
            error: stderr || `Command exited with code ${code}`,
          });
        }
      });

      proc.on('error', (error) => {
        resolve({
          success: false,
          output: '',
          error: error.message,
        });
      });
    });
  },
};

export const shellTools: Tool[] = [shellTool];
