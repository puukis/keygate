import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getConfigDir } from '../config/env.js';
import type { ChannelType } from '../types.js';

export interface RoutingRule {
  id: string;
  channel: ChannelType | '*';
  accountId?: string;
  chatId?: string;
  userId?: string;
  agentKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoutingRuleInput {
  channel: ChannelType | '*';
  accountId?: string;
  chatId?: string;
  userId?: string;
  agentKey: string;
}

interface RoutingStorePayload {
  version: 1;
  rules: RoutingRule[];
}

const ALLOWED_CHANNELS = new Set<RoutingRule['channel']>(['*', 'web', 'discord', 'slack', 'terminal']);
const MAX_AGENT_KEY_CHARS = 64;

function storePath(): string {
  return path.join(getConfigDir(), 'routing-rules.json');
}

function defaultPayload(): RoutingStorePayload {
  return { version: 1, rules: [] };
}

async function loadPayload(): Promise<RoutingStorePayload> {
  try {
    const raw = await fs.readFile(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<RoutingStorePayload>;
    return {
      version: 1,
      rules: Array.isArray(parsed.rules) ? parsed.rules.filter((rule): rule is RoutingRule => typeof rule?.id === 'string') : [],
    };
  } catch {
    return defaultPayload();
  }
}

async function savePayload(payload: RoutingStorePayload): Promise<void> {
  const target = storePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(temp, target);
}

export class RoutingRuleStore {
  async listRules(): Promise<RoutingRule[]> {
    const payload = await loadPayload();
    return payload.rules.map((r) => ({ ...r }));
  }

  async createRule(input: RoutingRuleInput): Promise<RoutingRule> {
    const agentKey = sanitizeAgentKey(input.agentKey);
    if (!agentKey) {
      throw new Error('agentKey is required');
    }
    if (agentKey.length > MAX_AGENT_KEY_CHARS) {
      throw new Error(`agentKey exceeds ${MAX_AGENT_KEY_CHARS} characters`);
    }
    if (!ALLOWED_CHANNELS.has(input.channel)) {
      throw new Error(`Unsupported channel: ${input.channel}`);
    }

    const now = new Date().toISOString();
    const rule: RoutingRule = {
      id: randomUUID(),
      channel: input.channel,
      accountId: input.accountId?.trim() || undefined,
      chatId: input.chatId?.trim() || undefined,
      userId: input.userId?.trim() || undefined,
      agentKey,
      createdAt: now,
      updatedAt: now,
    };

    const payload = await loadPayload();
    payload.rules.push(rule);
    await savePayload(payload);
    return { ...rule };
  }

  async deleteRule(ruleId: string): Promise<boolean> {
    const payload = await loadPayload();
    const before = payload.rules.length;
    payload.rules = payload.rules.filter((rule) => rule.id !== ruleId);
    const changed = payload.rules.length !== before;
    if (changed) {
      await savePayload(payload);
    }
    return changed;
  }
}

function sanitizeAgentKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
