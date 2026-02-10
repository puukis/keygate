import * as path from 'node:path';
import * as os from 'node:os';
import type {
  ConfirmationDecision,
  ConfirmationDetails,
  SecurityMode,
  Tool,
  ToolCall,
  ToolResult,
  Channel,
} from '../types.js';
import type { Gateway } from '../gateway/Gateway.js';
import { getDefaultWorkspacePath } from '../config/env.js';
import { withEnvOverlay } from '../runtime/index.js';

const MANAGED_CONTEXT_FILES = new Set([
  'soul.md',
  'user.md',
  'bootstrap.md',
  'identity.md',
  'memory.md',
]);

/**
 * ToolExecutor - Mode-switching security middleware
 * 
 * Safe Mode:
 * - Path jail to workspace directory
 * - Command allowlist (git, ls, npm, cat, node)
 * - Human-in-the-loop confirmation for write/execute
 * 
 * Spicy Mode:
 * - Full host access
 * - Unrestricted shell
 * - Autonomous execution
 */
export class ToolExecutor {
  private mode: SecurityMode;
  private workspacePath: string;
  private agentContextPath: string;
  private allowedBinaries: Set<string>;
  private allowAlwaysSignatures = new Set<string>();
  private toolRegistry = new Map<string, Tool>();
  private gateway: Gateway;

  constructor(
    mode: SecurityMode,
    workspacePath: string,
    allowedBinaries: string[],
    gateway: Gateway
  ) {
    this.mode = mode;
    this.workspacePath = path.resolve(this.expandPath(workspacePath));
    this.agentContextPath = path.resolve(this.expandPath(getDefaultWorkspacePath()));
    this.allowedBinaries = new Set(allowedBinaries);
    this.gateway = gateway;
  }

  /**
   * Register a tool
   */
  registerTool(tool: Tool): void {
    this.toolRegistry.set(tool.name, tool);
  }

  /**
   * Get all registered tool definitions (for LLM)
   */
  getToolDefinitions(): Tool[] {
    return Array.from(this.toolRegistry.values());
  }

  /**
   * Set security mode
   */
  setMode(mode: SecurityMode): void {
    this.mode = mode;
  }

  /**
   * Execute a tool call with security checks
   */
  async execute(
    call: ToolCall,
    channel: Channel,
    sessionId: string,
    envOverlay: Record<string, string> = {}
  ): Promise<ToolResult> {
    const tool = this.toolRegistry.get(call.name);
    
    if (!tool) {
      return {
        success: false,
        output: '',
        error: `Unknown tool: ${call.name}`,
      };
    }

    // Emit tool:start event
    this.gateway.emit('tool:start', {
      sessionId,
      tool: call.name,
      args: call.arguments,
    });

    try {
      // Normalize filesystem path arguments before validation and execution.
      this.normalizeFilesystemCallPath(tool, call);

      // Apply security checks in Safe Mode
      if (this.mode === 'safe') {
        await this.applySafetyChecks(tool, call, channel);
      }

      // Execute the tool with turn-scoped env overlay (no global env mutation).
      const result = await withEnvOverlay(envOverlay, () => tool.handler(call.arguments));

      // Emit tool:end event
      this.gateway.emit('tool:end', {
        sessionId,
        tool: call.name,
        result,
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const result: ToolResult = {
        success: false,
        output: '',
        error: errorMessage,
      };

      this.gateway.emit('tool:end', {
        sessionId,
        tool: call.name,
        result,
      });

      return result;
    }
  }

  /**
   * Apply safety checks for Safe Mode
   */
  private async applySafetyChecks(
    tool: Tool,
    call: ToolCall,
    channel: Channel
  ): Promise<void> {
    // Path validation for filesystem tools
    if (tool.type === 'filesystem') {
      const targetPath = call.arguments['path'] as string | undefined;
      if (targetPath) {
        this.assertPathAllowedInSafeMode(targetPath);
      }
    }

    // Command validation for shell tools
    if (tool.type === 'shell') {
      const command = call.arguments['command'] as string | undefined;
      if (command) {
        this.assertManagedContinuityFilesNotEditedViaShell(command);
        this.assertBinaryAllowed(command);
      }
    }

    // Human-in-the-loop confirmation for dangerous operations
    if (tool.requiresConfirmation) {
      if (this.shouldBypassConfirmationForManagedMarkdown(tool, call)) {
        return;
      }

      if (this.isAlwaysAllowed(call)) {
        return;
      }

      const decision = await this.requestConfirmation(call, channel);
      if (decision === 'allow_always') {
        this.allowAlwaysSignatures.add(this.buildConfirmationSignature(call));
        return;
      }

      if (decision !== 'allow_once') {
        throw new Error('Action cancelled by user');
      }
    }
  }

  /**
   * Assert that a path is within the safe-mode allowlist.
   */
  private assertPathAllowedInSafeMode(targetPath: string): void {
    const resolvedPath = path.normalize(targetPath);

    if (this.isPathWithinRoot(resolvedPath, this.workspacePath)) {
      return;
    }

    if (this.isManagedContextAbsolutePath(resolvedPath)) {
      return;
    }

    throw new Error(
      `Access denied: Path "${targetPath}" is outside Safe Mode allowlist. ` +
      `Allowed: workspace "${this.workspacePath}" and managed context markdown files in "${this.agentContextPath}".`
    );
  }

  private normalizeFilesystemCallPath(tool: Tool, call: ToolCall): void {
    if (tool.type !== 'filesystem') {
      return;
    }

    const targetPath = call.arguments['path'];
    if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
      return;
    }

    call.arguments['path'] = this.resolveFilesystemPath(targetPath);
  }

  private resolveFilesystemPath(inputPath: string): string {
    const expandedPath = this.expandPath(inputPath.trim());

    if (path.isAbsolute(expandedPath)) {
      return path.normalize(expandedPath);
    }

    if (this.isManagedContextRelativePath(expandedPath)) {
      return path.resolve(this.agentContextPath, expandedPath);
    }

    return path.resolve(this.workspacePath, expandedPath);
  }

  private shouldBypassConfirmationForManagedMarkdown(tool: Tool, call: ToolCall): boolean {
    if (tool.type !== 'filesystem') {
      return false;
    }

    if (call.name !== 'write_file' && call.name !== 'delete_file') {
      return false;
    }

    const targetPath = call.arguments['path'];
    if (typeof targetPath !== 'string' || targetPath.length === 0) {
      return false;
    }

    return this.isManagedContextAbsolutePath(path.normalize(targetPath));
  }

  private isManagedContextRelativePath(inputPath: string): boolean {
    const normalized = inputPath
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/^\/+/, '')
      .toLowerCase();

    if (normalized.includes('..')) {
      return false;
    }

    if (MANAGED_CONTEXT_FILES.has(normalized)) {
      return true;
    }

    if (normalized === 'memory') {
      return true;
    }

    if (normalized.startsWith('memory/') && normalized.endsWith('.md')) {
      return true;
    }

    return false;
  }

  private isManagedContextAbsolutePath(absolutePath: string): boolean {
    if (!this.isPathWithinRoot(absolutePath, this.agentContextPath)) {
      return false;
    }

    const relative = path.relative(this.agentContextPath, absolutePath).replace(/\\/g, '/').toLowerCase();
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return false;
    }

    if (MANAGED_CONTEXT_FILES.has(relative)) {
      return true;
    }

    if (relative === 'memory') {
      return true;
    }

    if (relative.startsWith('memory/') && relative.endsWith('.md')) {
      return true;
    }

    return false;
  }

  private isPathWithinRoot(targetPath: string, rootPath: string): boolean {
    const relative = path.relative(rootPath, targetPath);
    if (relative === '') {
      return true;
    }

    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  /**
   * Assert that a command uses an allowed binary
   */
  private assertBinaryAllowed(command: string): void {
    // Extract the binary name from the command
    const parts = command.trim().split(/\s+/);
    const binary = parts[0];
    
    if (!binary) {
      throw new Error('Empty command');
    }

    // Handle absolute paths
    const binaryName = path.basename(binary);

    if (!this.allowedBinaries.has(binaryName)) {
      throw new Error(
        `Access denied: Binary "${binaryName}" is not in the allowlist. ` +
        `Allowed binaries: ${Array.from(this.allowedBinaries).join(', ')}`
      );
    }
  }

  private assertManagedContinuityFilesNotEditedViaShell(command: string): void {
    const normalized = command.toLowerCase();
    const continuityTargets = ['identity.md', 'user.md', 'soul.md', 'bootstrap.md', 'memory.md', 'memory/'];
    const touchesContinuityFiles = continuityTargets.some((target) => normalized.includes(target));

    if (!touchesContinuityFiles) {
      return;
    }

    throw new Error(
      'Use filesystem tools (read_file/write_file) for continuity markdown files. ' +
      'Shell-based edits to SOUL.md/USER.md/IDENTITY.md/BOOTSTRAP.md/MEMORY.md are blocked in Safe Mode.'
    );
  }

  /**
   * Request human confirmation for a tool call
   */
  private async requestConfirmation(
    call: ToolCall,
    channel: Channel
  ): Promise<ConfirmationDecision> {
    const details = this.buildConfirmationDetails(call);
    const prompt = `🔐 Confirmation Required\n${details.summary}`;
    return channel.requestConfirmation(prompt, details);
  }

  private isAlwaysAllowed(call: ToolCall): boolean {
    return this.allowAlwaysSignatures.has(this.buildConfirmationSignature(call));
  }

  private buildConfirmationSignature(call: ToolCall): string {
    const command = typeof call.arguments['command'] === 'string' ? call.arguments['command'].trim() : '';
    const cwd = typeof call.arguments['cwd'] === 'string' ? call.arguments['cwd'].trim() : '';
    const targetPath = typeof call.arguments['path'] === 'string' ? path.normalize(call.arguments['path']) : '';

    if (command.length > 0) {
      return `tool:${call.name}|command:${command}|cwd:${cwd}`;
    }

    if (targetPath.length > 0) {
      return `tool:${call.name}|path:${targetPath}`;
    }

    return `tool:${call.name}|args:${stableStringify(call.arguments)}`;
  }

  private buildConfirmationDetails(call: ToolCall): ConfirmationDetails {
    const tool = call.name;
    const command = typeof call.arguments['command'] === 'string'
      ? call.arguments['command'].trim()
      : undefined;
    const cwd = typeof call.arguments['cwd'] === 'string'
      ? call.arguments['cwd'].trim()
      : undefined;
    const targetPath = typeof call.arguments['path'] === 'string'
      ? call.arguments['path']
      : undefined;

    if (command) {
      return {
        tool,
        action: 'shell command',
        summary: `Run command \`${command}\`${cwd ? ` in \`${cwd}\`` : ''}.`,
        command,
        cwd,
        args: call.arguments,
      };
    }

    if (targetPath) {
      return {
        tool,
        action: 'filesystem change',
        summary: `Modify path \`${targetPath}\`.`,
        path: targetPath,
        args: call.arguments,
      };
    }

    return {
      tool,
      action: 'tool execution',
      summary: `Execute \`${tool}\` with provided arguments.`,
      args: call.arguments,
    };
  }

  /**
   * Expand ~ to home directory
   */
  private expandPath(inputPath: string): string {
    if (inputPath.startsWith('~')) {
      return path.join(os.homedir(), inputPath.slice(1));
    }
    return inputPath;
  }

  /**
   * Get the resolved workspace path
   */
  getWorkspacePath(): string {
    return this.workspacePath;
  }

  /**
   * Get current mode
   */
  getMode(): SecurityMode {
    return this.mode;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${key}:${stableStringify(entry)}`);
    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value);
}
