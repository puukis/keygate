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
  handler: async (args, context): Promise<ToolResult> => {
    if (context.signal.aborted) {
      return cancelledToolResult();
    }

    const command = args['command'] as string;
    const cwd = args['cwd'] as string | undefined;
    
    return new Promise((resolve) => {
      let settled = false;

      const finish = (result: ToolResult) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };

      // Parse command into binary and args
      const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
      const binary = parts[0] ?? '';
      if (!binary) {
        finish({
          success: false,
          output: '',
          error: 'Command is empty.',
        });
        return;
      }
      const cmdArgs = parts.slice(1).map(arg => arg.replace(/^"|"$/g, ''));

      const proc = spawn(binary, cmdArgs, {
        cwd,
        shell: false,
        env: buildToolProcessEnv(),
        timeout: 60000, // 60 second timeout
      });

      const abortNow = () => {
        if (proc.killed) {
          return;
        }

        try {
          proc.kill('SIGTERM');
        } catch {
          // Ignore cancellation races.
        }
      };

      const forceStop = () => {
        if (proc.killed) {
          return;
        }

        try {
          proc.kill('SIGKILL');
        } catch {
          // Ignore force-stop races.
        }
      };

      context.registerAbortCleanup(forceStop);
      context.signal.addEventListener('abort', abortNow, { once: true });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        context.signal.removeEventListener('abort', abortNow);
        if (context.signal.aborted) {
          finish(cancelledToolResult(stdout));
          return;
        }

        if (code === 0) {
          finish({
            success: true,
            output: stdout || '(no output)',
          });
        } else {
          finish({
            success: false,
            output: stdout,
            error: stderr || `Command exited with code ${code}`,
          });
        }
      });

      proc.on('error', (error) => {
        context.signal.removeEventListener('abort', abortNow);
        if (context.signal.aborted) {
          finish(cancelledToolResult(stdout));
          return;
        }

        finish({
          success: false,
          output: '',
          error: error.message,
        });
      });
    });
  },
};

export const shellTools: Tool[] = [shellTool];

function cancelledToolResult(output = ''): ToolResult {
  return {
    success: false,
    output,
    error: 'Command cancelled.',
  };
}
