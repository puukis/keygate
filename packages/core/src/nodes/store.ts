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

export type NodePermissionStatus = 'granted' | 'denied' | 'unknown';

export interface NodeRecord {
  id: string;
  name: string;
  capabilities: NodeCapability[];
  trusted: boolean;
  authToken?: string;
  platform?: string;
  version?: string;
  online?: boolean;
  permissions?: Partial<Record<NodeCapability, NodePermissionStatus>>;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  lastInvocationAt?: string;
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
  version: 2;
  nodes: NodeRecord[];
  pending: PairRequest[];
}

const PAIR_TTL_MS = 10 * 60 * 1000;
const ALLOWED_CAPABILITIES = new Set<NodeCapability>(['notify', 'location', 'camera', 'screen', 'shell', 'invoke']);

function storePath(): string {
  return path.join(getConfigDir(), 'nodes.json');
}

function defaultPayload(): NodeStorePayload {
  return { version: 2, nodes: [], pending: [] };
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
      version: 2,
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
    return payload.nodes.map((n) => sanitizeNodeRecord(n));
  }

  async describeNode(nodeId: string): Promise<NodeRecord | null> {
    const payload = await loadPayload();
    const node = payload.nodes.find((n) => n.id === nodeId);
    return node ? sanitizeNodeRecord(node) : null;
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
      authToken: randomUUID(),
      online: false,
      permissions: Object.fromEntries(request.capabilities.map((cap) => [cap, 'unknown'])) as Partial<Record<NodeCapability, NodePermissionStatus>>,
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

  async authenticateNode(nodeId: string, authToken: string): Promise<NodeRecord | null> {
    const payload = await loadPayload();
    const node = payload.nodes.find((entry) => entry.id === nodeId && entry.authToken === authToken);
    return node ? { ...node, capabilities: [...node.capabilities] } : null;
  }

  async updateNodeRuntime(
    nodeId: string,
    patch: {
      platform?: string;
      version?: string;
      online?: boolean;
      permissions?: Partial<Record<NodeCapability, NodePermissionStatus>>;
      lastInvocationAt?: string;
    }
  ): Promise<NodeRecord | null> {
    const payload = await loadPayload();
    const node = payload.nodes.find((entry) => entry.id === nodeId);
    if (!node) {
      return null;
    }

    if (patch.platform) {
      node.platform = patch.platform;
    }
    if (patch.version) {
      node.version = patch.version;
    }
    if (patch.online !== undefined) {
      node.online = patch.online;
    }
    if (patch.permissions) {
      node.permissions = {
        ...(node.permissions ?? {}),
        ...patch.permissions,
      };
    }
    if (patch.lastInvocationAt) {
      node.lastInvocationAt = patch.lastInvocationAt;
    }

    node.lastSeenAt = nowIso();
    node.updatedAt = node.lastSeenAt;
    await savePayload(payload);
    return sanitizeNodeRecord(node);
  }
}

function sanitizeNodeRecord(node: NodeRecord): NodeRecord {
  return {
    ...node,
    authToken: undefined,
    capabilities: [...node.capabilities],
    permissions: node.permissions ? { ...node.permissions } : undefined,
  };
}
