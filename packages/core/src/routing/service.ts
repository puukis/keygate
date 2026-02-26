import path from 'node:path';
import type { ChannelType } from '../types.js';
import type { RoutingRule, RoutingRuleStore } from './store.js';

export interface RoutingInput {
  channel: ChannelType;
  accountId?: string;
  chatId: string;
  userId?: string;
}

export interface RoutingResolution {
  sessionId: string;
  workspacePath: string;
  agentKey: string;
  matchedRuleId?: string;
}

export class RoutingService {
  constructor(
    private readonly store: RoutingRuleStore,
    private readonly workspaceRoot: string,
  ) {}

  async listRules() {
    return this.store.listRules();
  }

  async createRule(input: Parameters<RoutingRuleStore['createRule']>[0]) {
    return this.store.createRule(input);
  }

  async deleteRule(ruleId: string) {
    return this.store.deleteRule(ruleId);
  }

  async resolve(input: RoutingInput): Promise<RoutingResolution> {
    const rules = await this.store.listRules();
    const match = pickBestMatch(rules, input);
    const agentKey = match?.agentKey ?? 'default';

    return {
      sessionId: buildSessionId(input.channel, input.chatId, agentKey),
      workspacePath: path.join(this.workspaceRoot, 'agents', agentKey),
      agentKey,
      matchedRuleId: match?.id,
    };
  }
}

function buildSessionId(channel: ChannelType, chatId: string, agentKey: string): string {
  return `${channel}:${agentKey}:${chatId}`;
}

function pickBestMatch(rules: RoutingRule[], input: RoutingInput): RoutingRule | undefined {
  let best: { score: number; rule: RoutingRule } | undefined;

  for (const rule of rules) {
    if (rule.channel !== '*' && rule.channel !== input.channel) {
      continue;
    }

    if (rule.accountId && rule.accountId !== (input.accountId ?? '')) {
      continue;
    }

    if (rule.chatId && rule.chatId !== input.chatId) {
      continue;
    }

    if (rule.userId && rule.userId !== (input.userId ?? '')) {
      continue;
    }

    let score = 0;
    if (rule.channel !== '*') score += 1;
    if (rule.accountId) score += 4;
    if (rule.chatId) score += 8;
    if (rule.userId) score += 16;

    if (!best || score > best.score) {
      best = { score, rule };
    }
  }

  return best?.rule;
}
