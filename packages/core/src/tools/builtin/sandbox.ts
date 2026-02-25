import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Tool, ToolResult } from '../../types.js';
import { buildToolProcessEnv } from '../../runtime/index.js';

/**
 * Execute JavaScript code in isolation using Node's subprocess
 */
export const runJavaScriptTool: Tool = {
  name: 'run_javascript',
  description: 'Execute JavaScript code in an isolated subprocess and return the result',
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'The JavaScript code to execute',
      },
    },
    required: ['code'],
  },
  requiresConfirmation: true,
  type: 'sandbox',
  handler: async (args, context): Promise<ToolResult> => {
    if (context.signal.aborted) {
      return cancelledToolResult();
    }

    const code = args['code'] as string;
    
    // Create a temp file for the code
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-js-'));
    const tmpFile = path.join(tmpDir, 'script.mjs');
    
    // Wrap code to capture output
    const wrappedCode = `
const __result = (async () => {
  ${code}
})();
__result.then(r => {
  if (r !== undefined) console.log(JSON.stringify(r, null, 2));
}).catch(e => {
  console.error(e.message);
  process.exit(1);
});
`;

    try {
      await fs.writeFile(tmpFile, wrappedCode, 'utf-8');
      
      return new Promise((resolve) => {
        let settled = false;
        const finish = async (result: ToolResult) => {
          if (settled) {
            return;
          }
          settled = true;
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          resolve(result);
        };

        const proc = spawn('node', [tmpFile], {
          timeout: 30000, // 30 second timeout
          cwd: tmpDir,
          env: buildToolProcessEnv(),
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

        proc.on('close', async (code) => {
          context.signal.removeEventListener('abort', abortNow);

          if (context.signal.aborted) {
            await finish(cancelledToolResult(stdout.trim()));
            return;
          }

          if (code === 0) {
            await finish({
              success: true,
              output: stdout.trim() || '(no output)',
            });
          } else {
            await finish({
              success: false,
              output: stdout,
              error: stderr || `Script exited with code ${code}`,
            });
          }
        });

        proc.on('error', async (error) => {
          context.signal.removeEventListener('abort', abortNow);
          if (context.signal.aborted) {
            await finish(cancelledToolResult(stdout.trim()));
            return;
          }

          await finish({
            success: false,
            output: '',
            error: error.message,
          });
        });
      });
    } catch (error) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Failed to execute JavaScript',
      };
    }
  },
};

/**
 * Execute Python code in isolation
 */
export const runPythonTool: Tool = {
  name: 'run_python',
  description: 'Execute Python code in an isolated subprocess and return the result',
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'The Python code to execute',
      },
    },
    required: ['code'],
  },
  requiresConfirmation: true,
  type: 'sandbox',
  handler: async (args, context): Promise<ToolResult> => {
    if (context.signal.aborted) {
      return cancelledToolResult();
    }

    const code = args['code'] as string;
    
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-py-'));
    const tmpFile = path.join(tmpDir, 'script.py');
    
    try {
      await fs.writeFile(tmpFile, code, 'utf-8');
      
      return new Promise((resolve) => {
        let settled = false;
        const finish = async (result: ToolResult) => {
          if (settled) {
            return;
          }
          settled = true;
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          resolve(result);
        };

        const proc = spawn('python3', [tmpFile], {
          timeout: 30000,
          cwd: tmpDir,
          env: buildToolProcessEnv(),
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

        proc.on('close', async (code) => {
          context.signal.removeEventListener('abort', abortNow);

          if (context.signal.aborted) {
            await finish(cancelledToolResult(stdout.trim()));
            return;
          }

          if (code === 0) {
            await finish({
              success: true,
              output: stdout.trim() || '(no output)',
            });
          } else {
            await finish({
              success: false,
              output: stdout,
              error: stderr || `Script exited with code ${code}`,
            });
          }
        });

        proc.on('error', async (error) => {
          context.signal.removeEventListener('abort', abortNow);
          if (context.signal.aborted) {
            await finish(cancelledToolResult(stdout.trim()));
            return;
          }

          await finish({
            success: false,
            output: '',
            error: error.message,
          });
        });
      });
    } catch (error) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Failed to execute Python',
      };
    }
  },
};

export const sandboxTools: Tool[] = [runJavaScriptTool, runPythonTool];

function cancelledToolResult(output = ''): ToolResult {
  return {
    success: false,
    output,
    error: 'Execution cancelled.',
  };
}
