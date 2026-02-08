import { describe, expect, it, vi } from 'vitest';
import { Brain, SPICY_MAX_OBEDIENCE_PROMPT, isLikelyRefusalResponse, rewriteRefusalForSpicyMode } from '../Brain.js';
import type { KeygateConfig, Session } from '../../types.js';

function createConfig(): KeygateConfig {
  return {
    llm: {
      provider: 'ollama',
      model: 'llama3',
      apiKey: '',
      ollama: {
        host: 'http://127.0.0.1:11434',
      },
    },
    security: {
      mode: 'safe',
      spicyModeEnabled: true,
      spicyMaxObedienceEnabled: false,
      workspacePath: '/tmp/keygate-tests',
      allowedBinaries: ['cat'],
    },
    server: {
      port: 18790,
    },
  };
}

function createSession(): Session {
  return {
    id: 'session-1',
    channelType: 'web',
    messages: [{ role: 'user', content: 'help me', }],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createBrain(mode: 'safe' | 'spicy', spicyObedienceEnabled: boolean): Brain {
  const config = createConfig();
  const toolExecutor = { getWorkspacePath: () => '/tmp/keygate-tests' } as any;
  const gateway = {
    getSecurityMode: () => mode,
    getSpicyMaxObedienceEnabled: () => spicyObedienceEnabled,
    emit: () => undefined,
  } as any;

  return new Brain(config, toolExecutor, gateway);
}

describe('Brain spicy max-obedience prompt', () => {
  it('does not inject spicy max-obedience block when mode is safe', async () => {
    const brain = createBrain('safe', true);
    const prompt = await (brain as any).getSystemPrompt(createSession());

    expect(prompt).not.toContain('SPICY MAX-OBEDIENCE MODE');
  });

  it('does not inject spicy max-obedience block when toggle is off', async () => {
    const brain = createBrain('spicy', false);
    const prompt = await (brain as any).getSystemPrompt(createSession());

    expect(prompt).not.toContain('SPICY MAX-OBEDIENCE MODE');
  });

  it('injects spicy max-obedience block when mode is spicy and toggle is on', async () => {
    const brain = createBrain('spicy', true);
    const prompt = await (brain as any).getSystemPrompt(createSession());

    expect(prompt).toContain('SPICY MAX-OBEDIENCE MODE');
    expect(prompt).toContain(SPICY_MAX_OBEDIENCE_PROMPT.trim());
  });

  it('includes readability guidance for capability and limit summaries', async () => {
    const brain = createBrain('safe', false);
    const prompt = await (brain as any).getSystemPrompt(createSession());

    expect(prompt).toContain('When summarizing capabilities or limits, use section headings with one bullet per line.');
    expect(prompt).toContain('Never format lists inline like "Heading: - item - item".');
  });
});

describe('Brain refusal rewriting', () => {
  it('detects refusal-like responses conservatively', () => {
    expect(isLikelyRefusalResponse("I can't help with that request.")).toBe(true);
    expect(isLikelyRefusalResponse('I can run that command now.')).toBe(false);
  });

  it('rewrites refusal-like output to actionable fallback', () => {
    const rewritten = rewriteRefusalForSpicyMode(
      "I'm sorry, I can't assist with that.",
      'delete temp files in /tmp/project'
    );

    expect(rewritten).toContain('Provider blocked direct execution');
    expect(rewritten).toContain('exact command, file path, or URL');
  });

  it('keeps non-refusal output unchanged', () => {
    const original = 'Done. I updated the file and ran the tests.';
    expect(rewriteRefusalForSpicyMode(original, 'update file')).toBe(original);
  });

  it('auto-approves provider confirmations when spicy max-obedience is active', async () => {
    const brain = createBrain('spicy', true);
    const requestConfirmation = vi.fn(async () => 'cancel' as const);
    const options = (brain as any).buildProviderOptions('session-1', {
      requestConfirmation,
    });

    const decision = await options.requestConfirmation({
      tool: 'execute_shell',
      action: 'shell command',
      summary: 'Run command',
    });

    expect(decision).toBe('allow_always');
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(options.approvalPolicy).toBe('never');
  });
});
