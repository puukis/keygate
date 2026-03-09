import * as path from 'node:path';
import * as os from 'node:os';
import type {
  ConfirmationDecision,
  ConfirmationDetails,
  SecurityMode,
  Tool,
  ToolCall,
  ToolExecutionContext,
  ToolResult,
  Channel,
} from '../types.js';
import type { Gateway } from '../gateway/Gateway.js';
import { getDefaultWorkspacePath } from '../config/env.js';
import { withEnvOverlay } from '../runtime/index.js';
import {
  appendApprovalAudit,
  assessToolRisk,
  hasRememberedApproval,
  rememberApproval,
} from '../security/riskEngine.js';

const MANAGED_CONTEXT_FILES = new Set([
  'soul.md',
  'user.md',
  'bootstrap.md',
  'identity.md',
  'memory.md',
]);

const DEFAULT_EXECUTION_CONTEXT: ToolExecutionContext = {
  signal: new AbortController().signal,
  registerAbortCleanup: () => {},
};

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
  private toolOwners = new Map<string, string | null>();
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
  registerTool(tool: Tool, owner: string | null = null): void {
    if (this.toolRegistry.has(tool.name)) {
      throw new Error(`Tool is already registered: ${tool.name}`);
    }
    this.toolRegistry.set(tool.name, tool);
    this.toolOwners.set(tool.name, owner);
  }

  unregisterTool(name: string): void {
    this.toolRegistry.delete(name);
    this.toolOwners.delete(name);
  }

  hasTool(name: string): boolean {
    return this.toolRegistry.has(name);
  }

  getToolOwner(name: string): string | null | undefined {
    return this.toolOwners.get(name);
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
    envOverlay: Record<string, string> = {},
    context: ToolExecutionContext = DEFAULT_EXECUTION_CONTEXT,
  ): Promise<ToolResult> {
    throwIfAborted(context.signal);
    let effectiveCall = { ...call, arguments: { ...call.arguments } };
    let effectiveEnvOverlay = { ...envOverlay };
    const toolHookPayload = await this.gateway.plugins?.runHook?.('before_tool_call', {
      sessionId,
      toolName: call.name,
      arguments: { ...call.arguments },
      envOverlay: effectiveEnvOverlay,
    }) ?? {
      sessionId,
      toolName: call.name,
      arguments: { ...call.arguments },
      envOverlay: effectiveEnvOverlay,
    };
    if (toolHookPayload.arguments && typeof toolHookPayload.arguments === 'object' && !Array.isArray(toolHookPayload.arguments)) {
      effectiveCall = {
        ...effectiveCall,
        arguments: toolHookPayload.arguments as Record<string, unknown>,
      };
    }
    if (toolHookPayload.envOverlay && typeof toolHookPayload.envOverlay === 'object' && !Array.isArray(toolHookPayload.envOverlay)) {
      effectiveEnvOverlay = toolHookPayload.envOverlay as Record<string, string>;
    }

    const tool = this.toolRegistry.get(effectiveCall.name);
    
    if (!tool) {
      return {
        success: false,
        output: '',
        error: `Unknown tool: ${effectiveCall.name}`,
      };
    }

    // Emit tool:start event
    this.gateway.emit?.('tool:start', {
      sessionId,
      tool: effectiveCall.name,
      args: effectiveCall.arguments,
    });
    this.gateway.appendDebugEvent?.(sessionId, 'tool.start', `Starting tool ${effectiveCall.name}.`, {
      tool: effectiveCall.name,
    });

    try {
      // Normalize filesystem path arguments before validation and execution.
      this.normalizeFilesystemCallPath(tool, effectiveCall, sessionId);
      this.normalizeShellCallWorkingDirectory(tool, effectiveCall, sessionId);
      this.normalizeGitCallWorkingDirectory(tool, effectiveCall, sessionId);

      // Apply security checks in Safe Mode
      if (this.mode === 'safe') {
        await this.applySafetyChecks(tool, effectiveCall, channel, sessionId);
      }

      const sandboxExecutor = this.gateway.sandbox?.executeTool?.bind(this.gateway.sandbox);
      const result = this.mode === 'safe' && isDockerSandboxedTool(tool) && sandboxExecutor
        ? await sandboxExecutor(
            tool,
            effectiveCall,
            sessionId,
            this.getWorkspacePathForSession(sessionId)
          )
        : await withEnvOverlay(effectiveEnvOverlay, () => tool.handler(effectiveCall.arguments, context));
      throwIfAborted(context.signal);

      // Emit tool:end event
      this.gateway.emit?.('tool:end', {
        sessionId,
        tool: effectiveCall.name,
        result,
      });
      this.gateway.appendDebugEvent?.(sessionId, 'tool.end', `Completed tool ${effectiveCall.name}.`, {
        tool: effectiveCall.name,
        success: result.success,
      });
      await this.gateway.plugins?.runHook?.('after_tool_call', {
        sessionId,
        toolName: effectiveCall.name,
        arguments: { ...effectiveCall.arguments },
        result,
      });

      return result;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const result: ToolResult = {
        success: false,
        output: '',
        error: errorMessage,
      };

      this.gateway.emit?.('tool:end', {
        sessionId,
        tool: effectiveCall.name,
        result,
      });
      this.gateway.appendDebugEvent?.(sessionId, 'tool.error', `Tool ${effectiveCall.name} failed.`, {
        tool: effectiveCall.name,
        error: errorMessage,
      });
      await this.gateway.plugins?.runHook?.('after_tool_call', {
        sessionId,
        toolName: effectiveCall.name,
        arguments: { ...effectiveCall.arguments },
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
    channel: Channel,
    sessionId: string,
  ): Promise<void> {
    // Path validation for filesystem tools
    if (tool.type === 'filesystem') {
      const targetPath = call.arguments['path'] as string | undefined;
      if (targetPath) {
        this.assertPathAllowedInSafeMode(targetPath, sessionId);
      }
    }

    // Command validation for shell tools
    if (tool.type === 'shell') {
      const command = call.arguments['command'] as string | undefined;
      if (command) {
        this.assertManagedContinuityFilesNotEditedViaShell(command);
        this.assertBinaryAllowed(command);
      }

      const cwd = call.arguments['cwd'] as string | undefined;
      if (cwd) {
        this.assertShellWorkingDirectoryAllowedInSafeMode(cwd, sessionId);
      }
    }

    if (isGitToolName(tool.name)) {
      const cwd = call.arguments['cwd'] as string | undefined;
      if (cwd) {
        this.assertGitWorkingDirectoryAllowedInSafeMode(cwd, sessionId);
      }
    }

    // Human-in-the-loop confirmation for dangerous operations
    if (tool.requiresConfirmation) {
      const signature = this.buildConfirmationSignature(call);
      const risk = assessToolRisk(tool, call);

      if (this.shouldBypassConfirmationForManagedMarkdown(tool, call)) {
        await appendApprovalAudit({
          sessionId,
          toolName: tool.name,
          signature,
          risk,
          decision: 'auto_allow_low_risk',
          detail: 'managed continuity markdown bypass',
        });
        return;
      }

      if (this.isAlwaysAllowed(call)) {
        await appendApprovalAudit({
          sessionId,
          toolName: tool.name,
          signature,
          risk,
          decision: 'remembered_allow',
          detail: 'session remember allow_always',
        });
        return;
      }

      if (risk.level === 'low') {
        await appendApprovalAudit({
          sessionId,
          toolName: tool.name,
          signature,
          risk,
          decision: 'auto_allow_low_risk',
          detail: risk.reason,
        });
        return;
      }

      if (await hasRememberedApproval(signature, risk.level)) {
        await appendApprovalAudit({
          sessionId,
          toolName: tool.name,
          signature,
          risk,
          decision: 'remembered_allow',
          detail: 'persisted approval memory hit',
        });
        return;
      }

      let baseCommand = '';
      let baseCommandKey = '';
      let canPersistGlobalCommand = false;
      if (tool.type === 'shell' && typeof call.arguments['command'] === 'string') {
        const {
          extractBaseCommand,
          getAllowedCommandsSet,
          isGlobalAutoApprovalEligible,
          normalizeBaseCommand,
        } = await import('../config/allowedCommands.js');
        baseCommand = extractBaseCommand(call.arguments['command']);
        baseCommandKey = normalizeBaseCommand(baseCommand);
        canPersistGlobalCommand = isGlobalAutoApprovalEligible(baseCommandKey);
        if (baseCommandKey && canPersistGlobalCommand) {
          const globalAllowed = await getAllowedCommandsSet();
          if (globalAllowed.has(baseCommandKey)) {
            await appendApprovalAudit({
              sessionId,
              toolName: tool.name,
              signature,
              risk,
              decision: 'remembered_allow',
              detail: `global base command allowlist: ${baseCommand}`,
            });
            return;
          }
        }
      }

      const decision = await this.requestConfirmation(call, channel);
      if (decision === 'allow_always') {
        this.allowAlwaysSignatures.add(signature);
        await rememberApproval(signature, tool.name, risk.level);

        if (baseCommand && canPersistGlobalCommand) {
          const { addAllowedCommand } = await import('../config/allowedCommands.js');
          await addAllowedCommand(baseCommand);
        }

        await appendApprovalAudit({
          sessionId,
          toolName: tool.name,
          signature,
          risk,
          decision: 'allow_always',
          detail: 'user confirmed allow_always',
        });
        return;
      }

      if (decision === 'allow_once') {
        await appendApprovalAudit({
          sessionId,
          toolName: tool.name,
          signature,
          risk,
          decision: 'allow_once',
          detail: 'user confirmed allow_once',
        });
        return;
      }

      await appendApprovalAudit({
        sessionId,
        toolName: tool.name,
        signature,
        risk,
        decision: 'cancel',
        detail: 'user cancelled action',
      });
      throw new Error('Action cancelled by user');
    }
  }

  /**
   * Assert that a path is within the safe-mode allowlist.
   */
  private assertPathAllowedInSafeMode(targetPath: string, sessionId: string): void {
    const resolvedPath = path.normalize(targetPath);
    const workspacePath = this.getWorkspacePathForSession(sessionId);

    if (this.isPathWithinRoot(resolvedPath, workspacePath)) {
      return;
    }

    if (this.isManagedContextAbsolutePath(resolvedPath)) {
      return;
    }

    throw new Error(
      `Access denied: Path "${targetPath}" is outside Safe Mode allowlist. ` +
      `Allowed: workspace "${workspacePath}" and managed context markdown files in "${this.agentContextPath}".`
    );
  }

  private normalizeFilesystemCallPath(tool: Tool, call: ToolCall, sessionId: string): void {
    if (tool.type !== 'filesystem') {
      return;
    }

    const targetPath = call.arguments['path'];
    if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
      return;
    }

    call.arguments['path'] = this.resolveFilesystemPath(targetPath, sessionId);
  }

  private normalizeShellCallWorkingDirectory(tool: Tool, call: ToolCall, sessionId: string): void {
    if (tool.type !== 'shell') {
      return;
    }

    const workspacePath = this.getWorkspacePathForSession(sessionId);
    const cwd = call.arguments['cwd'];
    if (typeof cwd !== 'string' || cwd.trim().length === 0) {
      call.arguments['cwd'] = workspacePath;
      return;
    }

    const expandedPath = this.expandPath(cwd.trim());
    if (path.isAbsolute(expandedPath)) {
      call.arguments['cwd'] = path.normalize(expandedPath);
      return;
    }

    call.arguments['cwd'] = path.resolve(workspacePath, expandedPath);
  }

  private normalizeGitCallWorkingDirectory(tool: Tool, call: ToolCall, sessionId: string): void {
    if (!isGitToolName(tool.name)) {
      return;
    }

    const workspacePath = this.getWorkspacePathForSession(sessionId);
    const cwd = call.arguments['cwd'];
    if (typeof cwd !== 'string' || cwd.trim().length === 0) {
      call.arguments['cwd'] = workspacePath;
      return;
    }

    const expandedPath = this.expandPath(cwd.trim());
    if (path.isAbsolute(expandedPath)) {
      call.arguments['cwd'] = path.normalize(expandedPath);
      return;
    }

    call.arguments['cwd'] = path.resolve(workspacePath, expandedPath);
  }

  private assertShellWorkingDirectoryAllowedInSafeMode(cwd: string, sessionId: string): void {
    const resolvedPath = path.normalize(cwd);
    const workspacePath = this.getWorkspacePathForSession(sessionId);
    if (this.isPathWithinRoot(resolvedPath, workspacePath)) {
      return;
    }

    throw new Error(
      `Access denied: Shell cwd "${cwd}" is outside Safe Mode workspace "${workspacePath}".`
    );
  }

  private assertGitWorkingDirectoryAllowedInSafeMode(cwd: string, sessionId: string): void {
    const resolvedPath = path.normalize(cwd);
    const workspacePath = this.getWorkspacePathForSession(sessionId);
    if (this.isPathWithinRoot(resolvedPath, workspacePath)) {
      return;
    }

    throw new Error(
      `Access denied: Git cwd "${cwd}" is outside Safe Mode workspace "${workspacePath}".`
    );
  }

  private resolveFilesystemPath(inputPath: string, sessionId: string): string {
    const expandedPath = this.expandPath(inputPath.trim());

    if (path.isAbsolute(expandedPath)) {
      return path.normalize(expandedPath);
    }

    if (this.isManagedContextRelativePath(expandedPath)) {
      return path.resolve(this.agentContextPath, expandedPath);
    }

    return path.resolve(this.getWorkspacePathForSession(sessionId), expandedPath);
  }

  private shouldBypassConfirmationForManagedMarkdown(tool: Tool, call: ToolCall): boolean {
    if (tool.type !== 'filesystem') {
      return false;
    }

    if (call.name !== 'write_file' && call.name !== 'delete_file' && call.name !== 'edit_file' && call.name !== 'apply_patch') {
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

  private getWorkspacePathForSession(sessionId: string): string {
    const resolver = (this.gateway as unknown as { getSessionWorkspace?: (id: string) => string | undefined }).getSessionWorkspace;
    if (typeof resolver === 'function') {
      return resolver.call(this.gateway, sessionId) ?? this.workspacePath;
    }
    return this.workspacePath;
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

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }

  throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error('Session cancelled');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isDockerSandboxedTool(tool: Tool): boolean {
  return tool.type === 'filesystem' || tool.type === 'shell' || tool.type === 'sandbox';
}

function isGitToolName(toolName: string): boolean {
  return toolName === 'git_status'
    || toolName === 'git_diff'
    || toolName === 'git_log'
    || toolName === 'git_stage'
    || toolName === 'git_unstage'
    || toolName === 'git_discard'
    || toolName === 'git_commit';
}
