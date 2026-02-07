import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ToolExecutor } from '../ToolExecutor.js';
import type { Channel, Tool } from '../../types.js';
import { getDefaultWorkspacePath } from '../../config/env.js';

const writeFileTool: Tool = {
  name: 'write_file',
  description: 'write file',
  parameters: { type: 'object' },
  requiresConfirmation: true,
  type: 'filesystem',
  handler: async (args) => ({
    success: true,
    output: String(args['path'] ?? ''),
  }),
};

const readFileTool: Tool = {
  name: 'read_file',
  description: 'read file',
  parameters: { type: 'object' },
  requiresConfirmation: false,
  type: 'filesystem',
  handler: async (args) => ({
    success: true,
    output: String(args['path'] ?? ''),
  }),
};

function createChannel(
  decision: 'allow_once' | 'allow_always' | 'cancel'
): { channel: Channel; requestConfirmation: ReturnType<typeof vi.fn> } {
  const requestConfirmation = vi.fn(async () => decision);
  return {
    requestConfirmation,
    channel: {
      type: 'web',
      send: async () => undefined,
      sendStream: async () => undefined,
      requestConfirmation,
    },
  };
}

describe('ToolExecutor', () => {
  it('routes managed markdown files to the device context path and skips confirmation', async () => {
    const gateway = { emit: vi.fn() } as any;
    const executor = new ToolExecutor('safe', '/tmp/keygate-safe-workspace', ['cat'], gateway);
    executor.registerTool(writeFileTool);

    const { channel, requestConfirmation } = createChannel('cancel');
    const result = await executor.execute(
      { id: '1', name: 'write_file', arguments: { path: 'IDENTITY.md', content: 'x' } },
      channel
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe(path.join(getDefaultWorkspacePath(), 'IDENTITY.md'));
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('resolves regular relative paths inside configured workspace and still asks for confirmation', async () => {
    const workspace = '/tmp/keygate-safe-workspace';
    const gateway = { emit: vi.fn() } as any;
    const executor = new ToolExecutor('safe', workspace, ['cat'], gateway);
    executor.registerTool(writeFileTool);

    const { channel, requestConfirmation } = createChannel('allow_once');
    const result = await executor.execute(
      { id: '2', name: 'write_file', arguments: { path: 'notes.txt', content: 'x' } },
      channel
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe(path.join(workspace, 'notes.txt'));
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
  });

  it('blocks filesystem access outside safe-mode allowlist', async () => {
    const gateway = { emit: vi.fn() } as any;
    const executor = new ToolExecutor('safe', '/tmp/keygate-safe-workspace', ['cat'], gateway);
    executor.registerTool(readFileTool);

    const { channel } = createChannel('allow_once');
    const result = await executor.execute(
      { id: '3', name: 'read_file', arguments: { path: '/etc/passwd' } },
      channel
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('outside Safe Mode allowlist');
  });

  it('remembers allow always decisions for matching future calls', async () => {
    const workspace = '/tmp/keygate-safe-workspace';
    const gateway = { emit: vi.fn() } as any;
    const executor = new ToolExecutor('safe', workspace, ['cat'], gateway);
    executor.registerTool(writeFileTool);

    const first = createChannel('allow_always');
    const second = createChannel('cancel');

    const firstResult = await executor.execute(
      { id: '4', name: 'write_file', arguments: { path: 'notes.txt', content: 'a' } },
      first.channel
    );
    const secondResult = await executor.execute(
      { id: '5', name: 'write_file', arguments: { path: 'notes.txt', content: 'b' } },
      second.channel
    );

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(true);
    expect(first.requestConfirmation).toHaveBeenCalledTimes(1);
    expect(second.requestConfirmation).not.toHaveBeenCalled();
  });

  it('blocks shell-based edits to managed continuity markdown files', async () => {
    const gateway = { emit: vi.fn() } as any;
    const shellTool: Tool = {
      name: 'execute_shell',
      description: 'shell',
      parameters: { type: 'object' },
      requiresConfirmation: true,
      type: 'shell',
      handler: async () => ({ success: true, output: 'ok' }),
    };

    const executor = new ToolExecutor('safe', '/tmp/keygate-safe-workspace', ['cat', 'echo'], gateway);
    executor.registerTool(shellTool);

    const { channel } = createChannel('allow_once');
    const result = await executor.execute(
      {
        id: '6',
        name: 'execute_shell',
        arguments: { command: 'echo test > IDENTITY.md' },
      },
      channel
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Use filesystem tools (read_file/write_file)');
  });
});
