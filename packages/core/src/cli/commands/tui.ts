import * as readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { getDefaultWorkspacePath, loadConfigFromEnv } from '../../config/env.js';
import { ensureAgentWorkspaceFiles } from '../../workspace/agentWorkspace.js';
import { Gateway } from '../../gateway/index.js';
import { allBuiltinTools } from '../../tools/index.js';
import { BaseChannel, normalizeTerminalMessage } from '../../pipeline/index.js';
import type {
  ConfirmationDecision,
  ConfirmationDetails,
  KeygateConfig,
  SecurityMode,
} from '../../types.js';
import type { ParsedArgs } from '../argv.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const ACCENT = '\x1b[38;2;255;90;45m';
const ACCENT_DIM = '\x1b[38;2;209;74;34m';
const INFO = '\x1b[38;2;255;138;91m';
const SUCCESS = '\x1b[38;2;47;191;113m';
const WARN = '\x1b[38;2;255;176;32m';
const MUTED = '\x1b[38;2;139;127;119m';

const MAX_ACTIVITY_ENTRIES = 10;
const MIN_FRAME_WIDTH = 40;

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

interface ActivityEntry {
  timestamp: Date;
  status: string;
  detail?: string;
}

interface PendingConfirmationState {
  prompt: string;
  details?: ConfirmationDetails;
  resolve: (decision: ConfirmationDecision) => void;
}

interface SessionState {
  messages: ChatMessage[];
  streamBuffer: string;
  streamStartedAt: Date | null;
}

class TerminalChannel extends BaseChannel {
  type = 'terminal' as const;
  private ui: KeygateTui;

  constructor(ui: KeygateTui) {
    super();
    this.ui = ui;
  }

  async send(content: string): Promise<void> {
    this.ui.commitAssistantMessage(content);
  }

  async sendStream(stream: AsyncIterable<string>): Promise<void> {
    await this.ui.consumeAssistantStream(stream);
  }

  requestConfirmation(prompt: string, details?: ConfirmationDetails): Promise<ConfirmationDecision> {
    return this.ui.requestConfirmation(prompt, details);
  }
}

class KeygateTui {
  private gateway: Gateway;
  private config: KeygateConfig;
  private channel: TerminalChannel;
  private stdin: NodeJS.ReadStream;
  private stdout: NodeJS.WriteStream;
  private previousRawMode: boolean;
  private sessionToken: string;
  private session: SessionState;
  private activities: ActivityEntry[] = [];
  private pendingConfirmation: PendingConfirmationState | null = null;
  private waitingForResponse = false;
  private draft = '';
  private multilineMode = false;
  private multilineLines: string[] = [];
  private transcriptScrollOffset = 0;
  private mode: SecurityMode;
  private llmState: ReturnType<Gateway['getLLMState']>;
  private exitPromiseResolve: (() => void) | null = null;
  private keypressBound: ((str: string, key: readline.Key | undefined) => void) | null = null;
  private resizeBound: (() => void) | null = null;
  private gatewayUnsubscribe: Array<() => void> = [];
  private didTeardown = false;

  constructor(config: KeygateConfig, gateway: Gateway) {
    this.config = config;
    this.gateway = gateway;
    this.stdin = input as NodeJS.ReadStream;
    this.stdout = output;
    this.previousRawMode = this.stdin.isRaw ?? false;
    this.mode = this.gateway.getSecurityMode();
    this.llmState = this.gateway.getLLMState();
    this.sessionToken = createSessionToken();
    this.session = {
      messages: [],
      streamBuffer: '',
      streamStartedAt: null,
    };
    this.channel = new TerminalChannel(this);
  }

  get activeSessionId(): string {
    return `terminal:${this.sessionToken}`;
  }

  async run(): Promise<void> {
    this.ensureInteractiveTerminal();
    this.setupGatewayListeners();
    this.enterFullscreenMode();
    this.addSystemMessage(
      'Full-screen terminal chat started. Use /help for commands. Multiline mode: type { then finish with }.'
    );
    this.render();

    await new Promise<void>((resolve) => {
      this.exitPromiseResolve = resolve;
    });

    this.teardown();
  }

  async consumeAssistantStream(stream: AsyncIterable<string>): Promise<void> {
    this.session.streamStartedAt = new Date();
    this.session.streamBuffer = '';
    this.waitingForResponse = true;
    this.addActivity('Assistant is responding');
    this.render();

    for await (const chunk of stream) {
      this.session.streamBuffer += chunk;
      if (this.transcriptScrollOffset === 0) {
        this.render();
      }
    }

    const finalContent = this.session.streamBuffer.trim().length > 0
      ? this.session.streamBuffer
      : '(No response)';

    this.session.messages.push({
      role: 'assistant',
      content: sanitizeMessageContent(finalContent),
      timestamp: this.session.streamStartedAt ?? new Date(),
    });
    this.session.streamBuffer = '';
    this.session.streamStartedAt = null;
    this.waitingForResponse = false;
    this.addActivity('Response completed');
    this.render();
  }

  commitAssistantMessage(content: string): void {
    this.session.messages.push({
      role: 'assistant',
      content: sanitizeMessageContent(content),
      timestamp: new Date(),
    });
    this.session.streamBuffer = '';
    this.session.streamStartedAt = null;
    this.waitingForResponse = false;
    this.render();
  }

  requestConfirmation(prompt: string, details?: ConfirmationDetails): Promise<ConfirmationDecision> {
    this.addActivity('Confirmation requested', details?.summary ?? prompt);
    return new Promise((resolve) => {
      this.pendingConfirmation = { prompt, details, resolve };
      this.render();
    });
  }

  private ensureInteractiveTerminal(): void {
    if (!this.stdin.isTTY || !this.stdout.isTTY || typeof this.stdin.setRawMode !== 'function') {
      throw new Error('keygate tui requires an interactive terminal (TTY). Use `keygate serve` for web chat.');
    }
  }

  private setupGatewayListeners(): void {
    const onModeChanged = (event: { mode: SecurityMode }) => {
      this.mode = event.mode;
      this.addActivity('Security mode updated', event.mode);
      this.render();
    };
    this.gateway.on('mode:changed', onModeChanged);
    this.gatewayUnsubscribe.push(() => this.gateway.off('mode:changed', onModeChanged));

    const onToolStart = (event: { sessionId: string; tool: string }) => {
      if (event.sessionId !== this.activeSessionId) {
        return;
      }
      this.addActivity(`Tool start: ${event.tool}`);
      this.render();
    };
    this.gateway.on('tool:start', onToolStart);
    this.gatewayUnsubscribe.push(() => this.gateway.off('tool:start', onToolStart));

    const onToolEnd = (event: { sessionId: string; tool: string; result: { success: boolean } }) => {
      if (event.sessionId !== this.activeSessionId) {
        return;
      }
      this.addActivity(
        event.result.success ? `Tool done: ${event.tool}` : `Tool failed: ${event.tool}`
      );
      this.render();
    };
    this.gateway.on('tool:end', onToolEnd);
    this.gatewayUnsubscribe.push(() => this.gateway.off('tool:end', onToolEnd));

    const onProviderEvent = (event: { sessionId: string; event: { method: string } }) => {
      if (event.sessionId !== this.activeSessionId) {
        return;
      }
      this.addActivity(`Provider: ${event.event.method}`);
      this.render();
    };
    this.gateway.on('provider:event', onProviderEvent);
    this.gatewayUnsubscribe.push(() => this.gateway.off('provider:event', onProviderEvent));
  }

  private enterFullscreenMode(): void {
    clearTerminalScreen(this.stdout);
    this.stdout.write('\x1b[?1049h');
    this.stdout.write('\x1b[?25l');
    readline.emitKeypressEvents(this.stdin);
    this.stdin.setRawMode?.(true);
    this.stdin.resume();

    this.keypressBound = (str, key) => {
      void this.handleKeypress(str, key);
    };
    this.stdin.on('keypress', this.keypressBound);

    this.resizeBound = () => {
      this.render();
    };
    this.stdout.on('resize', this.resizeBound);
  }

  private teardown(): void {
    if (this.didTeardown) {
      return;
    }
    this.didTeardown = true;

    if (this.keypressBound) {
      this.stdin.off('keypress', this.keypressBound);
      this.keypressBound = null;
    }

    if (this.resizeBound) {
      this.stdout.off('resize', this.resizeBound);
      this.resizeBound = null;
    }

    for (const dispose of this.gatewayUnsubscribe) {
      dispose();
    }
    this.gatewayUnsubscribe = [];

    if (this.pendingConfirmation) {
      this.pendingConfirmation.resolve('cancel');
      this.pendingConfirmation = null;
    }

    this.stdin.setRawMode?.(this.previousRawMode);
    this.stdin.pause();
    this.stdout.write('\x1b[?25h');
    this.stdout.write('\x1b[?1049l');
  }

  private requestExit(): void {
    if (this.exitPromiseResolve) {
      const resolve = this.exitPromiseResolve;
      this.exitPromiseResolve = null;
      resolve();
    }
  }

  private async handleKeypress(str: string, key: readline.Key | undefined): Promise<void> {
    if (key?.ctrl && key.name === 'c') {
      this.requestExit();
      return;
    }

    if (key?.ctrl && key.name === 'l') {
      clearTerminalScreen(this.stdout);
      this.transcriptScrollOffset = 0;
      this.render();
      return;
    }

    if (this.pendingConfirmation) {
      this.handleConfirmationKey(str, key);
      return;
    }

    if (key?.name === 'pageup') {
      this.transcriptScrollOffset += 5;
      this.render();
      return;
    }

    if (key?.name === 'pagedown') {
      this.transcriptScrollOffset = Math.max(0, this.transcriptScrollOffset - 5);
      this.render();
      return;
    }

    if (key?.name === 'end') {
      this.transcriptScrollOffset = 0;
      this.render();
      return;
    }

    if (key?.name === 'backspace') {
      this.draft = dropLastCharacter(this.draft);
      this.render();
      return;
    }

    if (key?.name === 'return' || key?.name === 'enter') {
      const line = this.draft;
      this.draft = '';
      await this.handleEnteredLine(line);
      this.render();
      return;
    }

    if (key?.name === 'escape') {
      this.draft = '';
      this.render();
      return;
    }

    if (typeof str === 'string' && isPrintableInput(str) && !key?.meta && !key?.ctrl) {
      this.draft += str;
      this.render();
    }
  }

  private handleConfirmationKey(str: string, key: readline.Key | undefined): void {
    const normalized = (key?.name ?? str).toLowerCase();
    let decision: ConfirmationDecision | null = null;

    if (normalized === 'y') {
      decision = 'allow_once';
    } else if (normalized === 'a') {
      decision = 'allow_always';
    } else if (normalized === 'n') {
      decision = 'cancel';
    }

    if (!decision) {
      return;
    }

    const pending = this.pendingConfirmation;
    this.pendingConfirmation = null;
    if (!pending) {
      return;
    }
    pending.resolve(decision);
    this.addActivity('Confirmation decision', decision);
    this.render();
  }

  private async handleEnteredLine(rawLine: string): Promise<void> {
    const line = rawLine.trimEnd();
    if (this.multilineMode) {
      if (line.trim() === '}') {
        const payload = this.multilineLines.join('\n');
        this.multilineLines = [];
        this.multilineMode = false;
        if (payload.trim().length === 0) {
          this.addSystemMessage('Multiline input closed without content.');
          return;
        }
        await this.submitPrompt(payload, false);
        return;
      }

      this.multilineLines.push(rawLine);
      return;
    }

    if (line.trim().length === 0) {
      return;
    }

    if (line.trim() === '{') {
      this.multilineMode = true;
      this.multilineLines = [];
      this.addSystemMessage('Multiline mode enabled. End with a line containing only `}`.');
      return;
    }

    await this.submitPrompt(line, true);
  }

  private async submitPrompt(content: string, allowCommands: boolean): Promise<void> {
    if (allowCommands && content.startsWith('/')) {
      await this.handleSlashCommand(content);
      return;
    }

    if (this.waitingForResponse) {
      this.addSystemMessage('Wait for the current response to finish before sending a new prompt.');
      return;
    }

    this.session.messages.push({
      role: 'user',
      content: sanitizeMessageContent(content),
      timestamp: new Date(),
    });
    this.waitingForResponse = true;
    this.transcriptScrollOffset = 0;
    this.addActivity('User prompt sent');
    this.render();

    const normalized = normalizeTerminalMessage(this.sessionToken, 'terminal-user', content, this.channel);
    this.llmState = this.gateway.getLLMState();

    try {
      await this.gateway.processMessage(normalized);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addSystemMessage(`Error: ${message}`);
      this.waitingForResponse = false;
      this.render();
    }
  }

  private async handleSlashCommand(command: string): Promise<void> {
    const normalized = command.trim().toLowerCase();
    if (normalized === '/exit' || normalized === '/quit') {
      this.requestExit();
      return;
    }

    if (normalized === '/help') {
      this.addSystemMessage([
        'Commands:',
        '/help - show this help',
        '/new - start a fresh terminal session',
        '/exit or /quit - leave terminal chat',
        '',
        'Multiline input:',
        '- type `{` and press Enter to start',
        '- type `}` on its own line to send',
      ].join('\n'));
      return;
    }

    if (normalized === '/new') {
      if (this.waitingForResponse) {
        this.addSystemMessage('Cannot start a new session while a response is in progress.');
        return;
      }
      this.startNewSession();
      return;
    }

    this.addSystemMessage(`Unknown command: ${command}. Use /help.`);
  }

  private startNewSession(): void {
    this.sessionToken = createSessionToken();
    this.session = {
      messages: [],
      streamBuffer: '',
      streamStartedAt: null,
    };
    this.activities = [];
    this.pendingConfirmation = null;
    this.multilineMode = false;
    this.multilineLines = [];
    this.waitingForResponse = false;
    this.transcriptScrollOffset = 0;
    this.addSystemMessage(`Started new session: ${this.activeSessionId}`);
    this.render();
  }

  private addSystemMessage(content: string): void {
    this.session.messages.push({
      role: 'system',
      content: sanitizeMessageContent(content),
      timestamp: new Date(),
    });
  }

  private addActivity(status: string, detail?: string): void {
    this.activities.push({
      timestamp: new Date(),
      status,
      detail: detail && detail.trim().length > 0 ? sanitizeMessageContent(detail) : undefined,
    });

    if (this.activities.length > MAX_ACTIVITY_ENTRIES) {
      this.activities.shift();
    }
  }

  private render(): void {
    if (this.didTeardown) {
      return;
    }

    const rows = Math.max(20, this.stdout.rows ?? 28);
    const frameWidth = Math.max(MIN_FRAME_WIDTH, Math.min(120, this.stdout.columns ?? 100));
    const headerBody = [
      `Provider: ${this.llmState.provider}   Model: ${this.llmState.model}`,
      `Mode: ${this.mode}   Session: ${this.activeSessionId}   State: ${this.waitingForResponse ? 'busy' : 'idle'}`,
    ];
    const headerPanel = renderPanel('Keygate Terminal Chat', headerBody, frameWidth);

    const activityBody = buildActivityBody(this.activities, rows < 24 ? 1 : 2);
    const activityPanel = renderPanel('Live Activity', activityBody, frameWidth);

    const composerBody = buildComposerBody({
      draft: this.draft,
      multilineMode: this.multilineMode,
      multilineLines: this.multilineLines,
      waitingForResponse: this.waitingForResponse,
      pendingConfirmation: this.pendingConfirmation,
      width: frameWidth - 4,
      compact: rows < 24,
    });
    const composerPanel = renderPanel('Composer', composerBody, frameWidth);

    const reserved = headerPanel.length + activityPanel.length + composerPanel.length + 1;
    const transcriptBodyHeight = Math.max(1, rows - reserved - 3);
    const transcriptBody = this.buildTranscriptBody(frameWidth - 4, transcriptBodyHeight);
    const transcriptPanel = renderPanel(
      this.transcriptScrollOffset > 0
        ? `Conversation (scroll +${this.transcriptScrollOffset})`
        : 'Conversation',
      transcriptBody,
      frameWidth
    );

    const legend = `${ACCENT_DIM}PgUp/PgDn scroll • End jump bottom • Enter send • Esc clear line • Ctrl+C /exit quit${RESET}`;
    const lines = [
      ...headerPanel,
      ...transcriptPanel,
      ...activityPanel,
      ...composerPanel,
      legend,
    ];

    const trimmed = lines.slice(0, rows);
    while (trimmed.length < rows) {
      trimmed.push('');
    }

    readline.cursorTo(this.stdout, 0, 0);
    readline.clearScreenDown(this.stdout);
    this.stdout.write(`${trimmed.join('\n')}\n`);
  }

  private buildTranscriptBody(contentWidth: number, bodyHeight: number): string[] {
    const lines: string[] = [];

    if (this.session.messages.length === 0 && this.session.streamBuffer.length === 0) {
      lines.push(`${MUTED}No messages yet. Ask anything to start.${RESET}`);
    }

    for (const message of this.session.messages) {
      const roleLabel =
        message.role === 'user'
          ? `${INFO}You${RESET}`
          : message.role === 'assistant'
            ? `${SUCCESS}Keygate${RESET}`
            : `${WARN}System${RESET}`;

      lines.push(`${BOLD}[${formatTime(message.timestamp)}] ${roleLabel}${RESET}`);
      for (const wrapped of wrapText(message.content, Math.max(8, contentWidth - 2))) {
        lines.push(`  ${wrapped}`);
      }
      lines.push('');
    }

    if (this.session.streamBuffer.length > 0) {
      lines.push(`${BOLD}[${formatTime(this.session.streamStartedAt ?? new Date())}] ${SUCCESS}Keygate (typing)${RESET}`);
      for (const wrapped of wrapText(this.session.streamBuffer, Math.max(8, contentWidth - 2))) {
        lines.push(`  ${wrapped}`);
      }
    }

    if (lines.length === 0) {
      lines.push(`${MUTED}No messages yet.${RESET}`);
    }

    const maxOffset = Math.max(0, lines.length - bodyHeight);
    this.transcriptScrollOffset = Math.min(this.transcriptScrollOffset, maxOffset);

    const end = Math.max(0, lines.length - this.transcriptScrollOffset);
    const start = Math.max(0, end - bodyHeight);
    const visible = lines.slice(start, end);

    while (visible.length < bodyHeight) {
      visible.unshift('');
    }

    return visible;
  }
}

interface ComposerBodyInput {
  draft: string;
  multilineMode: boolean;
  multilineLines: string[];
  waitingForResponse: boolean;
  pendingConfirmation: PendingConfirmationState | null;
  width: number;
  compact: boolean;
}

function buildComposerBody(inputState: ComposerBodyInput): string[] {
  if (inputState.pendingConfirmation) {
    const prompt = inputState.pendingConfirmation.details?.summary ?? inputState.pendingConfirmation.prompt;
    const wrappedPrompt = wrapText(prompt, Math.max(8, inputState.width));
    const lines = wrappedPrompt.slice(0, inputState.compact ? 1 : 2);
    lines.push(`${WARN}Approve: y=once • a=always • n=cancel${RESET}`);
    return lines;
  }

  if (inputState.multilineMode) {
    const currentLine = `> ${inputState.draft}`;
    const lines = [
      `Multiline mode: ${inputState.multilineLines.length} buffered lines (finish with \`}\`)`,
      ...wrapText(currentLine, Math.max(8, inputState.width)).slice(0, inputState.compact ? 1 : 2),
    ];
    return lines;
  }

  const prefix = inputState.waitingForResponse ? '[busy] > ' : '> ';
  const lines = wrapText(`${prefix}${inputState.draft}`, Math.max(8, inputState.width)).slice(0, inputState.compact ? 1 : 2);
  if (lines.length === 0) {
    lines.push('> ');
  }
  return lines;
}

function buildActivityBody(entries: ActivityEntry[], maxLines: number): string[] {
  if (entries.length === 0) {
    return [`${MUTED}No activity yet.${RESET}`];
  }

  const recent = entries.slice(-maxLines);
  return recent.map((entry) => {
    const base = `${formatTime(entry.timestamp)} ${entry.status}`;
    if (!entry.detail) {
      return base;
    }
    return `${base} - ${entry.detail}`;
  });
}

function renderPanel(title: string, bodyLines: string[], width: number): string[] {
  const panelWidth = width;
  const innerWidth = panelWidth - 2;
  const contentWidth = innerWidth - 2;
  const lines: string[] = [];

  lines.push(`${ACCENT}┌${'─'.repeat(innerWidth)}┐${RESET}`);
  lines.push(`${ACCENT}│${RESET} ${BOLD}${padText(title, contentWidth)}${RESET} ${ACCENT}│${RESET}`);

  for (const line of bodyLines) {
    lines.push(`${ACCENT}│${RESET} ${padText(truncateText(line, contentWidth), contentWidth)} ${ACCENT}│${RESET}`);
  }

  lines.push(`${ACCENT}└${'─'.repeat(innerWidth)}┘${RESET}`);
  return lines;
}

function sanitizeMessageContent(value: string): string {
  return value.replace(/\r/g, '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
}

function isPrintableInput(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  return /^[^\u0000-\u001F\u007F]$/.test(value);
}

function dropLastCharacter(value: string): string {
  const chars = Array.from(value);
  chars.pop();
  return chars.join('');
}

function wrapText(value: string, maxWidth: number): string[] {
  const width = Math.max(1, maxWidth);
  const normalized = sanitizeMessageContent(value).replace(/\t/g, '  ');
  const rows: string[] = [];

  for (const originalLine of normalized.split('\n')) {
    const chars = Array.from(originalLine);
    if (chars.length === 0) {
      rows.push('');
      continue;
    }

    for (let index = 0; index < chars.length; index += width) {
      rows.push(chars.slice(index, index + width).join(''));
    }
  }

  return rows;
}

function truncateText(value: string, maxLength: number): string {
  const plain = stripAnsi(value);
  const chars = Array.from(plain);
  if (chars.length <= maxLength) {
    return plain;
  }

  if (maxLength <= 1) {
    return chars.slice(0, maxLength).join('');
  }

  return `${chars.slice(0, maxLength - 1).join('')}…`;
}

function padText(value: string, maxLength: number): string {
  const plain = stripAnsi(value);
  const chars = Array.from(plain);
  if (chars.length >= maxLength) {
    return chars.slice(0, maxLength).join('');
  }

  return `${plain}${' '.repeat(maxLength - chars.length)}`;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

function clearTerminalScreen(stream: NodeJS.WriteStream): void {
  // 2J clears visible screen, 3J clears scrollback, H moves cursor to top-left.
  stream.write('\x1b[2J\x1b[3J\x1b[H');
}

function formatTime(value: Date): string {
  return value.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function createSessionToken(): string {
  return crypto.randomUUID();
}

export async function runTuiCommand(_args: ParsedArgs): Promise<void> {
  const config = loadConfigFromEnv();
  await ensureAgentWorkspaceFiles(getDefaultWorkspacePath());
  const gateway = Gateway.getInstance(config);

  for (const tool of allBuiltinTools) {
    gateway.toolExecutor.registerTool(tool);
  }

  const tui = new KeygateTui(config, gateway);
  await tui.run();
}
