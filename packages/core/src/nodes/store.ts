import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { getConfigDir } from '../config/env.js';

export type NodeCapability =
  | 'notify'
  | 'location'
  | 'camera'
  | 'screen'
  | 'shell'
  | 'invoke';

export interface NodeRecord {
  id: string;
  name: string;
  capabilities: NodeCapability[];
  trusted: boolean;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface PairRequest {
  requestId: string;
  name: string;
  capabilities: NodeCapability[];
  pairingCode: string;
  createdAt: string;
  expiresAt: string;
}

interface NodeStorePayload {
  version: 1;
  nodes: NodeRecord[];
  pending: PairRequest[];
}

const PAIR_TTL_MS = 10 * 60 * 1000;
const ALLOWED_CAPABILITIES = new Set<NodeCapability>(['notify', 'location', 'camera', 'screen', 'shell', 'invoke']);

function storePath(): string {
  return path.join(getConfigDir(), 'nodes.json');
}

function defaultPayload(): NodeStorePayload {
  return { version: 1, nodes: [], pending: [] };
}

function nowIso(): string {
  return new Date().toISOString();
}

function generatePairCode(): string {
  return randomBytes(3).toString('hex').toUpperCase();
}

async function loadPayload(): Promise<NodeStorePayload> {
  try {
    const raw = await fs.readFile(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<NodeStorePayload>;
    return {
      version: 1,
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes.filter((n): n is NodeRecord => typeof n?.id === 'string') : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending.filter((p): p is PairRequest => typeof p?.requestId === 'string') : [],
    };
  } catch {
    return defaultPayload();
  }
}

async function savePayload(payload: NodeStorePayload): Promise<void> {
  const target = storePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(temp, target);
}

function compactPending(payload: NodeStorePayload): NodeStorePayload {
  const now = Date.now();
  payload.pending = payload.pending.filter((entry) => Date.parse(entry.expiresAt) > now);
  return payload;
}

export class NodeStore {
  async listNodes(): Promise<NodeRecord[]> {
    const payload = await loadPayload();
    return payload.nodes.map((n) => ({ ...n, capabilities: [...n.capabilities] }));
  }

  async describeNode(nodeId: string): Promise<NodeRecord | null> {
    const payload = await loadPayload();
    const node = payload.nodes.find((n) => n.id === nodeId);
    return node ? { ...node, capabilities: [...node.capabilities] } : null;
  }

  async createPairRequest(name: string, capabilities: NodeCapability[]): Promise<PairRequest> {
    const payload = compactPending(await loadPayload());
    const createdAt = nowIso();
    const filteredCapabilities = Array.from(new Set(capabilities)).filter((cap): cap is NodeCapability => ALLOWED_CAPABILITIES.has(cap));
    if (filteredCapabilities.length === 0) {
      throw new Error('At least one valid capability is required');
    }
    const request: PairRequest = {
      requestId: randomUUID(),
      name: name.trim() || 'Unnamed Node',
      capabilities: filteredCapabilities,
      pairingCode: generatePairCode(),
      createdAt,
      expiresAt: new Date(Date.now() + PAIR_TTL_MS).toISOString(),
    };
    payload.pending.push(request);
    await savePayload(payload);
    return { ...request, capabilities: [...request.capabilities] };
  }

  async listPendingRequests(): Promise<PairRequest[]> {
    const payload = compactPending(await loadPayload());
    await savePayload(payload);
    return payload.pending.map((p) => ({ ...p, capabilities: [...p.capabilities] }));
  }

  async approvePairRequest(requestId: string, pairingCode: string): Promise<NodeRecord> {
    const payload = compactPending(await loadPayload());
    const idx = payload.pending.findIndex((p) => p.requestId === requestId);
    if (idx < 0) {
      throw new Error('Pair request not found');
    }

    const request = payload.pending[idx]!;
    if (request.pairingCode !== pairingCode.trim().toUpperCase()) {
      throw new Error('Invalid pairing code');
    }

    payload.pending.splice(idx, 1);
    const now = nowIso();
    const node: NodeRecord = {
      id: randomUUID(),
      name: request.name,
      capabilities: request.capabilities,
      trusted: true,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    };
    payload.nodes.push(node);
    await savePayload(payload);
    return { ...node, capabilities: [...node.capabilities] };
  }

  async rejectPairRequest(requestId: string): Promise<boolean> {
    const payload = compactPending(await loadPayload());
    const before = payload.pending.length;
    payload.pending = payload.pending.filter((p) => p.requestId !== requestId);
    const changed = payload.pending.length !== before;
    if (changed) {
      await savePayload(payload);
    }
    return changed;
  }

  async touchNode(nodeId: string): Promise<void> {
    const payload = await loadPayload();
    const node = payload.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    node.lastSeenAt = nowIso();
    node.updatedAt = node.lastSeenAt;
    await savePayload(payload);
  }
}
