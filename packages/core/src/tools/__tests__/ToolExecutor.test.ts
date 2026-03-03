import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const shellPathProbeTool: Tool = {
  name: 'run_shell_probe',
  description: 'shell probe',
  parameters: { type: 'object' },
  requiresConfirmation: false,
  type: 'shell',
  handler: async (args) => ({
    success: true,
    output: String(args['cwd'] ?? ''),
  }),
};

const shellDangerTool: Tool = {
  name: 'execute_shell',
  description: 'shell',
  parameters: { type: 'object' },
  requiresConfirmation: true,
  type: 'shell',
  handler: async () => ({ success: true, output: 'ok' }),
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
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-toolexec-'));
    vi.stubEnv('XDG_CONFIG_HOME', tempRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
  it('routes managed markdown files to the device context path and skips confirmation', async () => {
    const emit = vi.fn();
    const gateway = { emit } as any;
    const executor = new ToolExecutor('safe', '/tmp/keygate-safe-workspace', ['cat'], gateway);
    executor.registerTool(writeFileTool);

    const { channel, requestConfirmation } = createChannel('cancel');
    const result = await executor.execute(
      { id: '1', name: 'write_file', arguments: { path: 'IDENTITY.md', content: 'x' } },
      channel,
      'web:session-1'
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe(path.join(getDefaultWorkspacePath(), 'IDENTITY.md'));
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(emit).toHaveBeenNthCalledWith(1, 'tool:start', expect.objectContaining({
      sessionId: 'web:session-1',
    }));
    expect(emit).toHaveBeenNthCalledWith(2, 'tool:end', expect.objectContaining({
      sessionId: 'web:session-1',
    }));
  });

  it('uses session-specific workspace overrides for filesystem resolution', async () => {
    const workspace = '/tmp/keygate-safe-workspace';
    const gateway = {
      emit: vi.fn(),
      getSessionWorkspace: (sessionId: string) => (sessionId === 'discord:alpha:123' ? '/tmp/keygate-agent-alpha' : undefined),
    } as any;
    const executor = new ToolExecutor('safe', workspace, ['cat'], gateway);
    executor.registerTool(writeFileTool);

    const { channel } = createChannel('allow_once');
    const result = await executor.execute(
      { id: '2a', name: 'write_file', arguments: { path: 'notes.txt', content: 'x' } },
      channel,
      'discord:alpha:123'
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe(path.join('/tmp/keygate-agent-alpha', 'notes.txt'));
  });

  it('resolves regular relative paths inside configured workspace and still asks for confirmation', async () => {
    const workspace = '/tmp/keygate-safe-workspace';
    const gateway = { emit: vi.fn() } as any;
    const executor = new ToolExecutor('safe', workspace, ['cat'], gateway);
    executor.registerTool(writeFileTool);

    const { channel, requestConfirmation } = createChannel('allow_once');
    const result = await executor.execute(
      { id: '2', name: 'write_file', arguments: { path: 'notes.txt', content: 'x' } },
      channel,
      'discord:12345'
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
      channel,
      'web:session-2'
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
      first.channel,
      'web:session-3'
    );
    const secondResult = await executor.execute(
      { id: '5', name: 'write_file', arguments: { path: 'notes.txt', content: 'b' } },
      second.channel,
      'web:session-3'
    );

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(true);
    expect(first.requestConfirmation).toHaveBeenCalledTimes(1);
    expect(second.requestConfirmation).not.toHaveBeenCalled();
  });

  it('persists allow_always approvals across executor instances (approval memory)', async () => {
    const workspace = '/tmp/keygate-safe-workspace';
    const gateway = { emit: vi.fn() } as any;

    const firstExecutor = new ToolExecutor('safe', workspace, ['cat', 'echo'], gateway);
    firstExecutor.registerTool(shellDangerTool);

    const first = createChannel('allow_always');
    const firstResult = await firstExecutor.execute(
      {
        id: 'persist-1',
        name: 'execute_shell',
        arguments: { command: 'echo hello' },
      },
      first.channel,
      'web:session-persist'
    );
    expect(firstResult.success).toBe(true);
    expect(first.requestConfirmation).toHaveBeenCalledTimes(1);

    const secondExecutor = new ToolExecutor('safe', workspace, ['cat', 'echo'], gateway);
    secondExecutor.registerTool(shellDangerTool);

    const second = createChannel('cancel');
    const secondResult = await secondExecutor.execute(
      {
        id: 'persist-2',
        name: 'execute_shell',
        arguments: { command: 'echo hello' },
      },
      second.channel,
      'web:session-persist'
    );

    expect(secondResult.success).toBe(true);
    expect(second.requestConfirmation).not.toHaveBeenCalled();
  });

  it('blocks shell-based edits to managed continuity markdown files', async () => {
    const gateway = { emit: vi.fn() } as any;
    const executor = new ToolExecutor('safe', '/tmp/keygate-safe-workspace', ['cat', 'echo'], gateway);
    executor.registerTool(shellDangerTool);

    const { channel } = createChannel('allow_once');
    const result = await executor.execute(
      {
        id: '6',
        name: 'execute_shell',
        arguments: { command: 'echo test > IDENTITY.md' },
      },
      channel,
      'web:session-4'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Use filesystem tools (read_file/write_file)');
  });

  it('defaults shell cwd to configured workspace when omitted', async () => {
    const workspace = '/tmp/keygate-safe-workspace';
    const gateway = { emit: vi.fn() } as any;
    const executor = new ToolExecutor('safe', workspace, ['cat'], gateway);
    executor.registerTool(shellPathProbeTool);

    const { channel } = createChannel('allow_once');
    const result = await executor.execute(
      {
        id: '7',
        name: 'run_shell_probe',
        arguments: { command: 'cat package.json' },
      },
      channel,
      'web:session-5'
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe(workspace);
  });

  it('blocks shell cwd outside configured workspace in safe mode', async () => {
    const workspace = '/tmp/keygate-safe-workspace';
    const gateway = { emit: vi.fn() } as any;
    const executor = new ToolExecutor('safe', workspace, ['cat'], gateway);
    executor.registerTool(shellPathProbeTool);

    const { channel } = createChannel('allow_once');
    const result = await executor.execute(
      {
        id: '8',
        name: 'run_shell_probe',
        arguments: { command: 'cat package.json', cwd: '/tmp' },
      },
      channel,
      'web:session-6'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('outside Safe Mode workspace');
  });

  it('tracks owners for registered tools and removes them cleanly', () => {
    const gateway = { emit: vi.fn() } as any;
    const executor = new ToolExecutor('safe', '/tmp/keygate-safe-workspace', ['cat'], gateway);

    executor.registerTool(readFileTool, 'plugin:test');

    expect(executor.hasTool('read_file')).toBe(true);
    expect(executor.getToolOwner('read_file')).toBe('plugin:test');

    executor.unregisterTool('read_file');

    expect(executor.hasTool('read_file')).toBe(false);
    expect(executor.getToolOwner('read_file')).toBeUndefined();
  });
});
