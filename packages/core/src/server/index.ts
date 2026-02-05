import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Gateway } from '../gateway/index.js';
import { normalizeWebMessage, BaseChannel } from '../pipeline/index.js';
import { allBuiltinTools } from '../tools/index.js';
import type { KeygateConfig, SecurityMode } from '../types.js';
import 'dotenv/config';

const PORT = 18790;

interface WSMessage {
  type: 'message' | 'confirm_response' | 'set_mode' | 'clear_session';
  sessionId?: string;
  content?: string;
  confirmed?: boolean;
  mode?: SecurityMode;
}

/**
 * WebSocket Channel adapter
 */
class WebSocketChannel extends BaseChannel {
  type = 'web' as const;
  private ws: WebSocket;
  private sessionId: string;
  private pendingConfirmation: ((confirmed: boolean) => void) | null = null;

  constructor(ws: WebSocket, sessionId: string) {
    super();
    this.ws = ws;
    this.sessionId = sessionId;
  }

  async send(content: string): Promise<void> {
    this.ws.send(JSON.stringify({
      type: 'message',
      sessionId: this.sessionId,
      content,
    }));
  }

  async sendStream(stream: AsyncIterable<string>): Promise<void> {
    for await (const chunk of stream) {
      this.ws.send(JSON.stringify({
        type: 'chunk',
        sessionId: this.sessionId,
        content: chunk,
      }));
    }
    this.ws.send(JSON.stringify({
      type: 'stream_end',
      sessionId: this.sessionId,
    }));
  }

  async requestConfirmation(prompt: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingConfirmation = resolve;
      this.ws.send(JSON.stringify({
        type: 'confirm_request',
        sessionId: this.sessionId,
        prompt,
      }));

      // Timeout after 60 seconds
      setTimeout(() => {
        if (this.pendingConfirmation) {
          this.pendingConfirmation(false);
          this.pendingConfirmation = null;
        }
      }, 60000);
    });
  }

  handleConfirmResponse(confirmed: boolean): void {
    if (this.pendingConfirmation) {
      this.pendingConfirmation(confirmed);
      this.pendingConfirmation = null;
    }
  }
}

/**
 * Start the WebSocket server
 */
export function startWebServer(config: KeygateConfig): void {
  const gateway = Gateway.getInstance(config);
  
  // Register all built-in tools
  for (const tool of allBuiltinTools) {
    gateway.toolExecutor.registerTool(tool);
  }

  const server = createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Simple REST endpoints
    if (req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        mode: gateway.getSecurityMode(),
        spicyEnabled: config.security.spicyModeEnabled,
      }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  const wss = new WebSocketServer({ server });
  const channels = new Map<string, WebSocketChannel>();

  wss.on('connection', (ws) => {
    const sessionId = crypto.randomUUID();
    const channel = new WebSocketChannel(ws, sessionId);
    channels.set(sessionId, channel);

    console.log(`Client connected: ${sessionId}`);

    // Send initial state
    ws.send(JSON.stringify({
      type: 'connected',
      sessionId,
      mode: gateway.getSecurityMode(),
      spicyEnabled: config.security.spicyModeEnabled,
    }));

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString()) as WSMessage;

        switch (msg.type) {
          case 'message': {
            const content = msg.content?.trim();
            if (!content) return;

            const normalized = normalizeWebMessage(
              sessionId,
              'web-user',
              content,
              channel
            );

            // Send acknowledgment
            ws.send(JSON.stringify({ type: 'message_received', sessionId }));

            await gateway.processMessage(normalized);
            break;
          }

          case 'confirm_response': {
            channel.handleConfirmResponse(msg.confirmed ?? false);
            break;
          }

          case 'set_mode': {
            if (msg.mode) {
              try {
                gateway.setSecurityMode(msg.mode);
                ws.send(JSON.stringify({
                  type: 'mode_changed',
                  mode: msg.mode,
                }));
              } catch (error) {
                ws.send(JSON.stringify({
                  type: 'error',
                  error: error instanceof Error ? error.message : 'Failed to change mode',
                }));
              }
            }
            break;
          }

          case 'clear_session': {
            gateway.clearSession(`web:${sessionId}`);
            ws.send(JSON.stringify({ type: 'session_cleared', sessionId }));
            break;
          }
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
        ws.send(JSON.stringify({
          type: 'error',
          error: 'Invalid message format',
        }));
      }
    });

    ws.on('close', () => {
      console.log(`Client disconnected: ${sessionId}`);
      channels.delete(sessionId);
    });
  });

  // Forward gateway events to all connected clients
  gateway.on('tool:start', (event) => {
    broadcast(wss, { type: 'tool_start', ...event });
  });

  gateway.on('tool:end', (event) => {
    broadcast(wss, { type: 'tool_end', ...event });
  });

  gateway.on('mode:changed', (event) => {
    broadcast(wss, { type: 'mode_changed', ...event });
  });

  server.listen(config.server.port, () => {
    console.log(`🌐 Keygate Web Server running on http://localhost:${config.server.port}`);
  });
}

function broadcast(wss: WebSocketServer, data: object): void {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

export { WebSocketChannel };
