import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Tool, ToolCall } from '../types.js';
import { getConfigDir } from '../config/env.js';

export type RiskLevel = 'low' | 'medium' | 'high';
export type ApprovalDecision = 'auto_allow_low_risk' | 'remembered_allow' | 'allow_once' | 'allow_always' | 'cancel';

interface StoredApproval {
  signature: string;
  toolName: string;
  riskLevel: RiskLevel;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
}

interface ApprovalStore {
  version: 1;
  entries: StoredApproval[];
}

export interface RiskAssessment {
  level: RiskLevel;
  score: number;
  reason: string;
}

const DEFAULT_TTL_HOURS = 24 * 7;

function approvalsPath(): string {
  return path.join(getConfigDir(), 'approvals-risk.json');
}

function auditPath(): string {
  return path.join(getConfigDir(), 'approvals-audit.jsonl');
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultStore(): ApprovalStore {
  return { version: 1, entries: [] };
}

async function loadStore(): Promise<ApprovalStore> {
  try {
    const raw = await fs.readFile(approvalsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ApprovalStore>;
    if (!Array.isArray(parsed.entries)) {
      return defaultStore();
    }

    return {
      version: 1,
      entries: parsed.entries.filter((entry): entry is StoredApproval =>
        Boolean(entry)
        && typeof (entry as StoredApproval).signature === 'string'
        && typeof (entry as StoredApproval).toolName === 'string'
        && typeof (entry as StoredApproval).riskLevel === 'string'
        && typeof (entry as StoredApproval).createdAt === 'string'
        && typeof (entry as StoredApproval).expiresAt === 'string'
        && typeof (entry as StoredApproval).lastUsedAt === 'string'
      ),
    };
  } catch {
    return defaultStore();
  }
}

async function saveStore(store: ApprovalStore): Promise<void> {
  await fs.mkdir(getConfigDir(), { recursive: true });
  await fs.writeFile(approvalsPath(), `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function isExpired(isoDate: string): boolean {
  const ts = Date.parse(isoDate);
  if (!Number.isFinite(ts)) {
    return true;
  }
  return ts <= Date.now();
}

function cleanup(store: ApprovalStore): ApprovalStore {
  store.entries = store.entries.filter((entry) => !isExpired(entry.expiresAt));
  return store;
}

function riskRank(level: RiskLevel): number {
  return level === 'high' ? 3 : level === 'medium' ? 2 : 1;
}

export function assessToolRisk(tool: Tool, call: ToolCall): RiskAssessment {
  const command = typeof call.arguments['command'] === 'string' ? call.arguments['command'].toLowerCase() : '';

  if (tool.type === 'shell') {
    if (/\brm\s+-rf\b|\bsudo\b|\bcurl\b.+\|\s*(sh|bash)|\bmkfs\b|\bdd\b/.test(command)) {
      return { level: 'high', score: 98, reason: 'destructive or privilege shell command pattern detected' };
    }
    return { level: 'high', score: 88, reason: 'shell execution can mutate system state' };
  }

  if (tool.type === 'filesystem') {
    if (call.name === 'delete_file' || call.name === 'apply_patch' || call.name === 'edit_file' || call.name === 'write_file') {
      return { level: 'high', score: 82, reason: 'filesystem mutation' };
    }
    return { level: 'low', score: 18, reason: 'filesystem read-like access' };
  }

  if (tool.type === 'browser') {
    return { level: 'medium', score: 62, reason: 'browser automation can perform external actions' };
  }

  if (/delete|remove|uninstall|revoke|publish|send/i.test(call.name)) {
    return { level: 'medium', score: 58, reason: 'action-oriented tool name implies side effects' };
  }

  return { level: 'low', score: 22, reason: 'non-shell, non-mutating default risk class' };
}

export async function hasRememberedApproval(signature: string, requestedRisk: RiskLevel): Promise<boolean> {
  const store = cleanup(await loadStore());
  const match = store.entries.find((entry) => entry.signature === signature);
  if (!match) {
    await saveStore(store);
    return false;
  }

  if (riskRank(match.riskLevel) < riskRank(requestedRisk)) {
    await saveStore(store);
    return false;
  }

  match.lastUsedAt = nowIso();
  await saveStore(store);
  return true;
}

export async function rememberApproval(signature: string, toolName: string, riskLevel: RiskLevel): Promise<void> {
  const ttlHours = Math.max(1, Number.parseInt(process.env['KEYGATE_APPROVAL_TTL_HOURS'] ?? '', 10) || DEFAULT_TTL_HOURS);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

  const store = cleanup(await loadStore());
  const existing = store.entries.find((entry) => entry.signature === signature);
  if (existing) {
    existing.riskLevel = riskLevel;
    existing.expiresAt = expiresAt;
    existing.lastUsedAt = createdAt;
  } else {
    store.entries.push({
      signature,
      toolName,
      riskLevel,
      createdAt,
      expiresAt,
      lastUsedAt: createdAt,
    });
  }

  await saveStore(store);
}

export async function appendApprovalAudit(event: {
  sessionId: string;
  toolName: string;
  signature: string;
  risk: RiskAssessment;
  decision: ApprovalDecision;
  detail?: string;
}): Promise<void> {
  const line = JSON.stringify({
    ts: nowIso(),
    sessionId: event.sessionId,
    tool: event.toolName,
    signature: event.signature,
    risk: event.risk,
    decision: event.decision,
    detail: event.detail ?? '',
  });

  await fs.mkdir(getConfigDir(), { recursive: true });
  await fs.appendFile(auditPath(), `${line}\n`, 'utf8');
}
