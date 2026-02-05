import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Tool, ToolResult } from '../../types.js';

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
  handler: async (args): Promise<ToolResult> => {
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
        const proc = spawn('node', [tmpFile], {
          timeout: 30000, // 30 second timeout
          cwd: tmpDir,
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        proc.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        proc.on('close', async (code) => {
          // Cleanup
          await fs.rm(tmpDir, { recursive: true, force: true });

          if (code === 0) {
            resolve({
              success: true,
              output: stdout.trim() || '(no output)',
            });
          } else {
            resolve({
              success: false,
              output: stdout,
              error: stderr || `Script exited with code ${code}`,
            });
          }
        });

        proc.on('error', async (error) => {
          await fs.rm(tmpDir, { recursive: true, force: true });
          resolve({
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
  handler: async (args): Promise<ToolResult> => {
    const code = args['code'] as string;
    
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-py-'));
    const tmpFile = path.join(tmpDir, 'script.py');
    
    try {
      await fs.writeFile(tmpFile, code, 'utf-8');
      
      return new Promise((resolve) => {
        const proc = spawn('python3', [tmpFile], {
          timeout: 30000,
          cwd: tmpDir,
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        proc.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        proc.on('close', async (code) => {
          await fs.rm(tmpDir, { recursive: true, force: true });

          if (code === 0) {
            resolve({
              success: true,
              output: stdout.trim() || '(no output)',
            });
          } else {
            resolve({
              success: false,
              output: stdout,
              error: stderr || `Script exited with code ${code}`,
            });
          }
        });

        proc.on('error', async (error) => {
          await fs.rm(tmpDir, { recursive: true, force: true });
          resolve({
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
