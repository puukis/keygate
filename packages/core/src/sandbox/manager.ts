import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { KeygateConfig, Tool, ToolCall, ToolResult } from '../types.js';

export interface SandboxRuntimeRecord {
  scopeKey: string;
  containerName: string;
  running: boolean;
  image: string;
  workspacePath: string;
}

export interface SandboxHealth {
  backend: 'docker';
  available: boolean;
  degraded: boolean;
  image: string;
  scope: KeygateConfig['security']['sandbox']['scope'];
  detail: string;
}

export class SandboxManager {
  constructor(private readonly config: KeygateConfig) {}

  async getHealth(): Promise<SandboxHealth> {
    const sandboxConfig = this.getSandboxConfig();
    const available = await this.isDockerAvailable();
    return {
      backend: 'docker',
      available,
      degraded: !available,
      image: sandboxConfig.image,
      scope: sandboxConfig.scope,
      detail: available
        ? `Docker sandbox ready with image ${sandboxConfig.image}.`
        : 'Docker is unavailable. Safe-mode sandboxed tools cannot run until Docker is installed and the daemon is running.',
    };
  }

  async list(): Promise<SandboxRuntimeRecord[]> {
    if (!(await this.isDockerAvailable())) {
      return [];
    }

    const result = await runProcess('docker', [
      'ps',
      '--filter',
      'label=dev.keygate.managed=true',
      '--format',
      '{{.Names}}\t{{.Image}}\t{{.Status}}',
    ]);
    if (result.code !== 0) {
      return [];
    }

    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [containerName, image] = line.split('\t');
        return {
          scopeKey: containerName.replace(/^keygate-sandbox-/, ''),
          containerName,
          running: true,
          image,
          workspacePath: this.config.security.workspacePath,
        };
      });
  }

  async explain(scopeKey: string): Promise<Record<string, unknown> | SandboxHealth> {
    const health = await this.getHealth();
    if (!health.available) {
      return health;
    }

    const containerName = this.containerName(scopeKey);
    const result = await runProcess('docker', [
      'inspect',
      containerName,
      '--format',
      '{{json .Config.Labels}}',
    ]);

    return {
      ...health,
      scopeKey,
      containerName,
      exists: result.code === 0,
      labels: result.code === 0 ? safeJsonParse(result.stdout.trim()) : undefined,
    };
  }

  async recreate(scopeKey: string, workspacePath: string): Promise<SandboxRuntimeRecord> {
    const sandboxConfig = this.getSandboxConfig();
    if (!(await this.isDockerAvailable())) {
      throw new Error('Docker is unavailable. Install Docker and ensure the daemon is running.');
    }

    const containerName = this.containerName(scopeKey);
    await runProcess('docker', ['rm', '-f', containerName]).catch(() => undefined);
    await this.ensureContainer(scopeKey, workspacePath);
    return {
      scopeKey,
      containerName,
      running: true,
      image: sandboxConfig.image,
      workspacePath,
    };
  }

  async cleanupOrphans(validScopeKeys: Set<string>): Promise<string[]> {
    if (!(await this.isDockerAvailable())) {
      return [];
    }

    const result = await runProcess('docker', [
      'ps',
      '-a',
      '--filter',
      'label=dev.keygate.managed=true',
      '--format',
      '{{.Names}}\t{{.Label "dev.keygate.scope_key"}}',
    ]);
    if (result.code !== 0) {
      return [];
    }

    const removed: string[] = [];
    for (const line of result.stdout.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
      const [containerName, scopeKey] = line.split('\t');
      if (!containerName || !scopeKey) {
        continue;
      }
      if (validScopeKeys.has(scopeKey)) {
        continue;
      }

      const removal = await runProcess('docker', ['rm', '-f', containerName]);
      if (removal.code === 0) {
        removed.push(containerName);
      }
    }

    return removed;
  }

  async executeTool(
    tool: Tool,
    call: ToolCall,
    sessionId: string,
    workspacePath: string
  ): Promise<ToolResult> {
    const health = await this.getHealth();
    if (!health.available) {
      return {
        success: false,
        output: '',
        error: `${health.detail} Re-run with Docker available or switch to spicy mode.`,
      };
    }

    const scopeKey = this.resolveScopeKey(sessionId);
    await this.ensureContainer(scopeKey, workspacePath);

    switch (tool.type) {
      case 'filesystem':
        return this.executeFilesystemTool(call, scopeKey, workspacePath);
      case 'shell':
        return this.executeShellTool(call, scopeKey, workspacePath);
      case 'sandbox':
        return this.executeSandboxTool(call, scopeKey, workspacePath);
      default:
        return {
          success: false,
          output: '',
          error: `Tool type ${tool.type} is not supported by the Docker sandbox.`,
        };
    }
  }

  private async executeFilesystemTool(
    call: ToolCall,
    scopeKey: string,
    workspacePath: string
  ): Promise<ToolResult> {
    const target = typeof call.arguments['path'] === 'string' ? call.arguments['path'] : '';
    const containerPath = this.toContainerPath(target, workspacePath);

    switch (call.name) {
      case 'read_file':
        return this.exec(scopeKey, ['sh', '-lc', `cat -- ${shellEscape(containerPath)}`]);
      case 'list_directory':
        return this.exec(scopeKey, ['sh', '-lc', `ls -la -- ${shellEscape(containerPath)}`]);
      case 'delete_file':
        return this.exec(scopeKey, ['sh', '-lc', `rm -f -- ${shellEscape(containerPath)} && printf 'Deleted %s' ${shellEscape(containerPath)}`]);
      case 'write_file': {
        const content = typeof call.arguments['content'] === 'string' ? call.arguments['content'] : '';
        const mkdirCommand = `mkdir -p -- "$(dirname ${shellEscape(containerPath)})"; cat > ${shellEscape(containerPath)}`;
        return this.exec(scopeKey, ['sh', '-lc', mkdirCommand], content);
      }
      default:
        return {
          success: false,
          output: '',
          error: `Filesystem tool ${call.name} is not routed through the Docker sandbox.`,
        };
    }
  }

  private async executeShellTool(
    call: ToolCall,
    scopeKey: string,
    workspacePath: string
  ): Promise<ToolResult> {
    const command = typeof call.arguments['command'] === 'string' ? call.arguments['command'] : '';
    const cwd = typeof call.arguments['cwd'] === 'string' ? call.arguments['cwd'] : workspacePath;
    const containerCwd = this.toContainerPath(cwd, workspacePath);
    return this.exec(scopeKey, ['sh', '-lc', command], undefined, containerCwd);
  }

  private async executeSandboxTool(
    call: ToolCall,
    scopeKey: string,
    workspacePath: string
  ): Promise<ToolResult> {
    const id = randomUUID().slice(0, 8);
    if (call.name === 'run_python') {
      const code = typeof call.arguments['code'] === 'string' ? call.arguments['code'] : '';
      const scriptPath = `/tmp/keygate-${id}.py`;
      await this.exec(scopeKey, ['sh', '-lc', `cat > ${shellEscape(scriptPath)}`], code, this.toContainerPath(workspacePath, workspacePath));
      return this.exec(scopeKey, ['python3', scriptPath], undefined, this.toContainerPath(workspacePath, workspacePath));
    }

    if (call.name === 'run_javascript') {
      const code = typeof call.arguments['code'] === 'string' ? call.arguments['code'] : '';
      const scriptPath = `/tmp/keygate-${id}.mjs`;
      await this.exec(scopeKey, ['sh', '-lc', `cat > ${shellEscape(scriptPath)}`], code, this.toContainerPath(workspacePath, workspacePath));
      return this.exec(scopeKey, ['node', scriptPath], undefined, this.toContainerPath(workspacePath, workspacePath));
    }

    return {
      success: false,
      output: '',
      error: `Sandbox tool ${call.name} is not routed through the Docker sandbox.`,
    };
  }

  private async exec(
    scopeKey: string,
    command: string[],
    stdin?: string,
    cwd = '/workspace'
  ): Promise<ToolResult> {
    const containerName = this.containerName(scopeKey);
    const result = await runProcess('docker', ['exec', '-i', '-w', cwd, containerName, ...command], stdin);
    return {
      success: result.code === 0,
      output: result.stdout.trim() || result.stderr.trim() || '(no output)',
      error: result.code === 0 ? undefined : (result.stderr.trim() || `Exited with code ${result.code}`),
    };
  }

  private async ensureContainer(scopeKey: string, workspacePath: string): Promise<void> {
    const sandboxConfig = this.getSandboxConfig();
    const containerName = this.containerName(scopeKey);
    const inspect = await runProcess('docker', ['inspect', containerName]);
    if (inspect.code === 0) {
      return;
    }

    const resolvedWorkspace = path.resolve(workspacePath);
    const runResult = await runProcess('docker', [
      'run',
      '-d',
      '--name',
      containerName,
      '--label',
      'dev.keygate.managed=true',
      '--label',
      `dev.keygate.scope=${sandboxConfig.scope}`,
      '--label',
      `dev.keygate.scope_key=${scopeKey}`,
      '--user',
      '1000:1000',
      '--workdir',
      '/workspace',
      '-v',
      `${resolvedWorkspace}:/workspace`,
      sandboxConfig.image,
      'sh',
      '-lc',
      'while true; do sleep 3600; done',
    ]);

    if (runResult.code !== 0) {
      throw new Error(runResult.stderr.trim() || 'Failed to start Docker sandbox container.');
    }
  }

  private resolveScopeKey(sessionId: string): string {
    return this.getSandboxConfig().scope === 'agent'
      ? sessionId
      : sessionId;
  }

  private getSandboxConfig(): KeygateConfig['security']['sandbox'] {
    const sandbox = this.config.security?.sandbox;
    return {
      backend: 'docker',
      scope: sandbox?.scope === 'agent' ? 'agent' : 'session',
      image: typeof sandbox?.image === 'string' && sandbox.image.trim().length > 0
        ? sandbox.image.trim()
        : 'ghcr.io/openai/openhands-runtime:latest',
      networkAccess: typeof sandbox?.networkAccess === 'boolean' ? sandbox.networkAccess : true,
      degradeWithoutDocker:
        typeof sandbox?.degradeWithoutDocker === 'boolean' ? sandbox.degradeWithoutDocker : true,
    };
  }

  private containerName(scopeKey: string): string {
    const normalized = scopeKey.replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 40);
    return `keygate-sandbox-${normalized || 'default'}`;
  }

  private toContainerPath(targetPath: string, workspacePath: string): string {
    const resolvedWorkspace = path.resolve(workspacePath);
    const resolvedTarget = path.resolve(targetPath);
    const relative = path.relative(resolvedWorkspace, resolvedTarget);
    if (!relative || relative === '.') {
      return '/workspace';
    }
    return path.posix.join('/workspace', relative.split(path.sep).join('/'));
  }

  private async isDockerAvailable(): Promise<boolean> {
    const result = await runProcess('docker', ['info', '--format', '{{.ServerVersion}}']);
    return result.code === 0;
  }
}

async function runProcess(
  command: string,
  args: string[],
  stdin?: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
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
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });

    proc.on('error', (error) => {
      resolve({
        code: 1,
        stdout,
        stderr: error.message,
      });
    });

    if (stdin) {
      proc.stdin.write(stdin);
    }
    proc.stdin.end();
  });
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
