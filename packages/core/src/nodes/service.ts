import type { NodeCapability, NodePermissionStatus, NodeRecord } from './store.js';
import { NodeStore } from './store.js';

const HIGH_RISK_CAPABILITIES = new Set<NodeCapability>(['shell', 'screen', 'camera']);

export interface NodeInvokeResult {
  ok: boolean;
  nodeId: string;
  capability: NodeCapability;
  mode: 'brokered';
  message: string;
  deniedReason?: string;
  params?: unknown;
  payload?: Record<string, unknown>;
}

export interface ConnectedNodeRuntime {
  platform?: string;
  version?: string;
  permissions?: Partial<Record<NodeCapability, NodePermissionStatus>>;
}

interface ConnectedNodeClient {
  invoke: (request: {
    nodeId: string;
    capability: NodeCapability;
    params?: unknown;
  }) => Promise<NodeInvokeResult>;
}

export class NodeService {
  private readonly connected = new Map<string, ConnectedNodeClient>();

  constructor(private readonly store: NodeStore = new NodeStore()) {}

  async listNodes() {
    return this.store.listNodes();
  }

  async describeNode(nodeId: string) {
    return this.store.describeNode(nodeId);
  }

  async requestPairing(name: string, capabilities: NodeCapability[]) {
    return this.store.createPairRequest(name, capabilities);
  }

  async listPendingPairings() {
    return this.store.listPendingRequests();
  }

  async approvePairing(requestId: string, pairingCode: string) {
    return this.store.approvePairRequest(requestId, pairingCode);
  }

  async rejectPairing(requestId: string) {
    return this.store.rejectPairRequest(requestId);
  }

  async registerNode(
    nodeId: string,
    authToken: string,
    runtime: ConnectedNodeRuntime,
    client: ConnectedNodeClient
  ): Promise<NodeRecord | null> {
    const authenticated = await this.store.authenticateNode(nodeId, authToken);
    if (!authenticated) {
      return null;
    }

    this.connected.set(nodeId, client);
    return this.store.updateNodeRuntime(nodeId, {
      platform: runtime.platform,
      version: runtime.version,
      online: true,
      permissions: runtime.permissions,
    });
  }

  async heartbeat(
    nodeId: string,
    authToken: string,
    runtime: ConnectedNodeRuntime
  ): Promise<NodeRecord | null> {
    const authenticated = await this.store.authenticateNode(nodeId, authToken);
    if (!authenticated) {
      return null;
    }

    return this.store.updateNodeRuntime(nodeId, {
      platform: runtime.platform,
      version: runtime.version,
      online: true,
      permissions: runtime.permissions,
    });
  }

  async disconnectNode(nodeId: string): Promise<void> {
    this.connected.delete(nodeId);
    await this.store.updateNodeRuntime(nodeId, { online: false });
  }

  async invokeNode(nodeId: string, capability: NodeCapability, params?: unknown): Promise<NodeInvokeResult> {
    const node = await this.store.describeNode(nodeId);
    if (!node) {
      return {
        ok: false,
        nodeId,
        capability,
        mode: 'brokered',
        message: 'Node not found',
        deniedReason: 'node_not_found',
      };
    }

    if (!node.trusted) {
      return {
        ok: false,
        nodeId,
        capability,
        mode: 'brokered',
        message: 'Node is not trusted',
        deniedReason: 'node_untrusted',
      };
    }

    if (!node.capabilities.includes(capability)) {
      return {
        ok: false,
        nodeId,
        capability,
        mode: 'brokered',
        message: `Capability '${capability}' is not granted for this node`,
        deniedReason: 'capability_not_granted',
      };
    }

    if (HIGH_RISK_CAPABILITIES.has(capability) && !isHighRiskAllowed(params)) {
      return {
        ok: false,
        nodeId,
        capability,
        mode: 'brokered',
        message: `Capability '${capability}' requires explicit high-risk acknowledgement`,
        deniedReason: 'high_risk_ack_required',
      };
    }

    const client = this.connected.get(nodeId);
    if (!client) {
      return {
        ok: false,
        nodeId,
        capability,
        mode: 'brokered',
        message: 'Node is offline',
        deniedReason: 'node_offline',
      };
    }

    await this.store.touchNode(nodeId);
    const result = await client.invoke({ nodeId, capability, params });
    await this.store.updateNodeRuntime(nodeId, {
      lastInvocationAt: new Date().toISOString(),
      online: true,
    });
    return result;
  }
}

function isHighRiskAllowed(params: unknown): boolean {
  if (!params || typeof params !== 'object') {
    return false;
  }

  return (params as { highRiskAck?: boolean }).highRiskAck === true;
}

export function getNodeCapabilities(node: NodeRecord): NodeCapability[] {
  return [...node.capabilities];
}
