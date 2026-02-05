import * as path from 'node:path';
import * as os from 'node:os';
import type {
  SecurityMode,
  Tool,
  ToolCall,
  ToolResult,
  Channel,
} from '../types.js';
import type { Gateway } from '../gateway/Gateway.js';

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
  private allowedBinaries: Set<string>;
  private toolRegistry = new Map<string, Tool>();
  private gateway: Gateway;

  constructor(
    mode: SecurityMode,
    workspacePath: string,
    allowedBinaries: string[],
    gateway: Gateway
  ) {
    this.mode = mode;
    this.workspacePath = this.expandPath(workspacePath);
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
  async execute(call: ToolCall, channel: Channel): Promise<ToolResult> {
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
      sessionId: 'current', // TODO: Pass session context
      tool: call.name,
      args: call.arguments,
    });

    try {
      // Apply security checks in Safe Mode
      if (this.mode === 'safe') {
        await this.applySafetyChecks(tool, call, channel);
      }

      // Execute the tool
      const result = await tool.handler(call.arguments);

      // Emit tool:end event
      this.gateway.emit('tool:end', {
        sessionId: 'current',
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
        sessionId: 'current',
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
        this.assertPathInWorkspace(targetPath);
      }
    }

    // Command validation for shell tools
    if (tool.type === 'shell') {
      const command = call.arguments['command'] as string | undefined;
      if (command) {
        this.assertBinaryAllowed(command);
      }
    }

    // Human-in-the-loop confirmation for dangerous operations
    if (tool.requiresConfirmation) {
      const confirmed = await this.requestConfirmation(call, channel);
      if (!confirmed) {
        throw new Error('Action cancelled by user');
      }
    }
  }

  /**
   * Assert that a path is within the workspace (jail)
   */
  private assertPathInWorkspace(targetPath: string): void {
    const resolvedPath = path.resolve(this.workspacePath, targetPath);
    const normalizedWorkspace = path.normalize(this.workspacePath);
    
    if (!resolvedPath.startsWith(normalizedWorkspace)) {
      throw new Error(
        `Access denied: Path "${targetPath}" is outside the workspace. ` +
        `Only paths within "${this.workspacePath}" are allowed in Safe Mode.`
      );
    }
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

  /**
   * Request human confirmation for a tool call
   */
  private async requestConfirmation(
    call: ToolCall,
    channel: Channel
  ): Promise<boolean> {
    const prompt = `🔐 Confirm action:\n\`${call.name}(${JSON.stringify(call.arguments)})\`\n\nProceed? [Y/n]`;
    return channel.requestConfirmation(prompt);
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
