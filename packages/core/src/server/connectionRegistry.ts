import type { WebSocket } from 'ws';
import type { ClientRole } from '../types.js';

export type ConnectionEventFamily =
  | 'chat'
  | 'canvas'
  | 'action'
  | 'voice'
  | 'memory'
  | 'status'
  | 'operator';

export interface ConnectionDescriptor {
  id: string;
  role: ClientRole;
  ws: WebSocket;
  visibleSessions: Set<string>;
  families: Set<ConnectionEventFamily>;
}

export class ConnectionRegistry {
  private readonly connections = new Map<string, ConnectionDescriptor>();

  register(connection: ConnectionDescriptor): void {
    this.connections.set(connection.id, connection);
  }

  unregister(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  update(connectionId: string, patch: Partial<Omit<ConnectionDescriptor, 'id' | 'ws'>>): void {
    const current = this.connections.get(connectionId);
    if (!current) {
      return;
    }

    this.connections.set(connectionId, {
      ...current,
      ...patch,
      visibleSessions: patch.visibleSessions ?? current.visibleSessions,
      families: patch.families ?? current.families,
    });
  }

  list(): ConnectionDescriptor[] {
    return Array.from(this.connections.values());
  }

  sendTo(connectionId: string, payload: object): void {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.ws.readyState !== connection.ws.OPEN) {
      return;
    }
    connection.ws.send(JSON.stringify(payload));
  }

  broadcast(params: {
    payload: object;
    family: ConnectionEventFamily;
    sessionId?: string;
    includeRoles?: ClientRole[];
  }): void {
    const message = JSON.stringify(params.payload);
    for (const connection of this.connections.values()) {
      if (connection.ws.readyState !== connection.ws.OPEN) {
        continue;
      }
      if (params.includeRoles && !params.includeRoles.includes(connection.role)) {
        continue;
      }
      if (!connection.families.has(params.family) && connection.role !== 'operator' && connection.role !== 'macos_operator') {
        continue;
      }
      if (params.sessionId && connection.role === 'webchat_guest' && !connection.visibleSessions.has(params.sessionId)) {
        continue;
      }
      connection.ws.send(message);
    }
  }
}
