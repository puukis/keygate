import type { Gateway } from './Gateway.js';
import type { Channel, CodexReasoningEffort, Session } from '../types.js';
import { NodeStore } from '../nodes/index.js';
import { GmailAutomationService } from '../gmail/index.js';

const KNOWN_PROVIDERS = new Set(['openai', 'gemini', 'ollama', 'openai-codex']);
const KNOWN_REASONING = new Set(['low', 'medium', 'high', 'xhigh']);

export class CommandRouter {
  constructor(private readonly gateway: Gateway) {}

  async maybeHandleImmediate(session: Session, channel: Channel, rawContent: string): Promise<boolean> {
    const content = rawContent.trim();
    if (!content.startsWith('/')) {
      return false;
    }

    const [commandToken] = content.slice(1).split(/\s+/g).filter(Boolean);
    const command = (commandToken ?? '').toLowerCase();

    if (command !== 'stop') {
      return false;
    }

    const hadActiveRun = this.gateway.hasActiveRun(session.id);
    this.gateway.cancelSessionRun(session.id, 'user');
    await this.sendCommandReply(
      session,
      channel,
      hadActiveRun
        ? 'Stopped the active run for this session.'
        : 'No active run is currently running for this session.',
      'command.stop',
    );
    return true;
  }

  async maybeHandle(session: Session, channel: Channel, rawContent: string): Promise<boolean> {
    const content = rawContent.trim();
    if (!content.startsWith('/')) {
      return false;
    }

    const [commandToken, ...args] = content.slice(1).split(/\s+/g).filter(Boolean);
    const command = (commandToken ?? '').toLowerCase();

    switch (command) {
      case 'help':
        await this.sendCommandReply(session, channel, buildHelpText(), 'command.help');
        return true;
      case 'status':
        await this.sendCommandReply(session, channel, await this.buildStatusText(session.id), 'command.status');
        return true;
      case 'model':
        await this.sendCommandReply(session, channel, await this.handleModelCommand(session, args), 'command.model');
        return true;
      case 'compact': {
        const result = await this.gateway.compactSession(session.id);
        await this.sendCommandReply(
          session,
          channel,
          `Session compacted.\nRef: ${result.ref}\n\n${result.summary}`,
          'command.compact',
        );
        return true;
      }
      case 'debug':
        await this.sendCommandReply(session, channel, this.handleDebugCommand(session.id, args), 'command.debug');
        return true;
      case 'stop':
        return this.maybeHandleImmediate(session, channel, rawContent);
      case 'new':
        this.gateway.clearSession(session.id);
        await this.sendCommandReply(session, channel, 'Started a fresh session in the current thread.', 'command.new');
        return true;
      case 'reset':
        this.gateway.clearSession(session.id);
        this.gateway.setSessionModelOverride(session.id, null);
        this.gateway.setSessionDebugMode(session.id, false);
        await this.sendCommandReply(
          session,
          channel,
          'Reset the current session history, model override, and debug buffer.',
          'command.reset',
        );
        return true;
      default:
        return false;
    }
  }

  private async handleModelCommand(session: Session, args: string[]): Promise<string> {
    const current = this.gateway.getLLMState(session.id);
    if (args.length === 0) {
      return `Current session model:\n- Provider: ${current.provider}\n- Model: ${current.model}\n- Reasoning: ${current.reasoningEffort ?? 'default'}`;
    }

    let provider = current.provider;
    let modelArgs = [...args];
    let reasoningEffort = current.reasoningEffort;

    if (KNOWN_PROVIDERS.has(modelArgs[0] ?? '')) {
      provider = modelArgs.shift() as typeof provider;
    }

    const last = modelArgs[modelArgs.length - 1]?.toLowerCase();
    if (last && KNOWN_REASONING.has(last)) {
      reasoningEffort = last as CodexReasoningEffort;
      modelArgs.pop();
    }

    const model = modelArgs.join(' ').trim();
    if (!model) {
      return 'Usage: /model [provider] <model> [low|medium|high|xhigh]';
    }

    this.gateway.setSessionModelOverride(session.id, {
      provider,
      model,
      reasoningEffort: provider === 'openai-codex' ? reasoningEffort : undefined,
    });
    return `Session model override updated.\n- Provider: ${provider}\n- Model: ${model}\n- Reasoning: ${provider === 'openai-codex' ? (reasoningEffort ?? 'default') : 'n/a'}`;
  }

  private handleDebugCommand(sessionId: string, args: string[]): string {
    const action = args[0]?.toLowerCase();
    if (action === 'on') {
      this.gateway.setSessionDebugMode(sessionId, true);
      return 'Debug mode enabled for this session.';
    }

    if (action === 'off') {
      this.gateway.setSessionDebugMode(sessionId, false);
      return 'Debug mode disabled for this session.';
    }

    const enabled = this.gateway.getSessionDebugMode(sessionId);
    const events = this.gateway.getSessionDebugEvents(sessionId).slice(-20);
    const lines = [
      `Debug mode: ${enabled ? 'on' : 'off'}`,
      '',
      'Recent events:',
      ...(events.length > 0
        ? events.map((event) => `- ${event.timestamp} ${event.type}: ${event.message}`)
        : ['- No debug events recorded for this session.']),
    ];

    return lines.join('\n');
  }

  private async buildStatusText(sessionId: string): Promise<string> {
    const llm = this.gateway.getLLMState(sessionId);
    const session = this.gateway.getSession(sessionId);
    const usage = session?.usage ?? this.gateway.db.getSessionUsageAggregate(sessionId);
    const [sandboxHealth, nodes, gmailHealth] = await Promise.all([
      this.gateway.sandbox.getHealth(),
      new NodeStore().listNodes(),
      new GmailAutomationService(this.gateway.config).getHealth(),
    ]);

    return [
      'Session status:',
      `- Provider: ${llm.provider}`,
      `- Model: ${llm.model}`,
      `- Reasoning: ${llm.reasoningEffort ?? 'default'}`,
      `- Security mode: ${this.gateway.getSecurityMode()}`,
      `- Debug mode: ${this.gateway.getSessionDebugMode(sessionId) ? 'on' : 'off'}`,
      `- Turns: ${usage.turnCount}`,
      `- Tokens: in ${usage.inputTokens} / out ${usage.outputTokens} / total ${usage.totalTokens}`,
      `- Cost: $${usage.costUsd.toFixed(6)}`,
      `- Compaction: ${session?.compactionSummaryRef ?? 'none'}`,
      `- Sandbox: ${sandboxHealth.available ? 'healthy' : 'degraded'} (${sandboxHealth.scope}, ${sandboxHealth.image})`,
      `- Nodes: ${nodes.filter((node) => node.online === true).length}/${nodes.length} online`,
      `- Gmail watches: ${gmailHealth.enabledWatches}/${gmailHealth.watches} enabled`,
    ].join('\n');
  }

  private async sendCommandReply(
    session: Session,
    channel: Channel,
    content: string,
    debugType: string,
  ): Promise<void> {
    const formatted = content.trim();
    await channel.send(formatted);
    await this.gateway.publishAssistantMessage(session, formatted, {
      debugType,
      debugMessage: 'Handled operator command.',
      debugData: { contentLength: formatted.length },
    });
  }
}

function buildHelpText(): string {
  return [
    'Operator commands:',
    '/help',
    '/status',
    '/model [provider] <model> [low|medium|high|xhigh]',
    '/compact',
    '/debug',
    '/debug on',
    '/debug off',
    '/stop',
    '/new',
    '/reset',
  ].join('\n');
}
