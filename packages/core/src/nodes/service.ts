import type { NodeCapability, NodeRecord } from './store.js';
import { NodeStore } from './store.js';

const HIGH_RISK_CAPABILITIES = new Set<NodeCapability>(['shell', 'screen', 'camera']);

export interface NodeInvokeResult {
  ok: boolean;
  nodeId: string;
  capability: NodeCapability;
  mode: 'stub';
  message: string;
  deniedReason?: string;
  params?: unknown;
}

export class NodeService {
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

  async invokeNode(nodeId: string, capability: NodeCapability, params?: unknown): Promise<NodeInvokeResult> {
    const node = await this.store.describeNode(nodeId);
    if (!node) {
      return {
        ok: false,
        nodeId,
        capability,
        mode: 'stub',
        message: 'Node not found',
        deniedReason: 'node_not_found',
      };
    }

    if (!node.trusted) {
      return {
        ok: false,
        nodeId,
        capability,
        mode: 'stub',
        message: 'Node is not trusted',
        deniedReason: 'node_untrusted',
      };
    }

    if (!node.capabilities.includes(capability)) {
      return {
        ok: false,
        nodeId,
        capability,
        mode: 'stub',
        message: `Capability '${capability}' is not granted for this node`,
        deniedReason: 'capability_not_granted',
      };
    }

    if (HIGH_RISK_CAPABILITIES.has(capability) && !isHighRiskAllowed(params)) {
      return {
        ok: false,
        nodeId,
        capability,
        mode: 'stub',
        message: `Capability '${capability}' requires explicit high-risk acknowledgement`,
        deniedReason: 'high_risk_ack_required',
      };
    }

    await this.store.touchNode(nodeId);

    return {
      ok: true,
      nodeId,
      capability,
      mode: 'stub',
      message: `Node invocation accepted in stub mode for capability '${capability}'`,
      params,
    };
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
