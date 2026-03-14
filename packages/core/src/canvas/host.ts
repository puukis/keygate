import * as fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import chokidar from 'chokidar';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CanvasStateMode, KeygateConfig } from '../types.js';

export interface CanvasUserActionEvent {
  sessionId: string;
  surfaceId: string;
  action: Record<string, unknown>;
}

export interface CanvasStateEvent {
  sessionId: string;
  surfaceId: string;
  path: string;
  mode: CanvasStateMode;
  state?: unknown;
  statusText?: string;
}

export interface CanvasHostHandler {
  handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  broadcastState(event: CanvasStateEvent): void;
  onUserAction(listener: (event: CanvasUserActionEvent) => void | Promise<void>): () => void;
  close(): Promise<void>;
}

function defaultCanvasHtml(config: KeygateConfig['canvas']): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%230b1020'/%3E%3Cpath d='M18 16h10v14l12-14h12L39 31l14 17H40L28 34v14H18V16Z' fill='%23f8fafc'/%3E%3C/svg%3E" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Keygate Canvas</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at top left, rgba(252, 211, 77, 0.24), transparent 26%),
          radial-gradient(circle at bottom right, rgba(59, 130, 246, 0.2), transparent 24%),
          #0b1020;
        color: #f8fafc;
        display: grid;
        place-items: center;
      }
      main {
        width: min(720px, calc(100vw - 32px));
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 24px;
        background: rgba(15, 23, 42, 0.88);
        box-shadow: 0 24px 72px rgba(15, 23, 42, 0.35);
        padding: 28px;
      }
      h1 {
        margin: 0 0 10px;
        font-size: 28px;
      }
      p {
        margin: 0 0 18px;
        color: rgba(248, 250, 252, 0.8);
      }
      button {
        appearance: none;
        border: 0;
        border-radius: 999px;
        background: linear-gradient(135deg, #f59e0b, #ef4444);
        color: white;
        font-weight: 700;
        padding: 12px 18px;
        cursor: pointer;
      }
      pre {
        margin: 18px 0 0;
        padding: 14px;
        border-radius: 16px;
        background: rgba(2, 6, 23, 0.7);
        overflow: auto;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Keygate Canvas</h1>
      <p>Agent-driven UI surface. This default page is live-reload aware and bridge-enabled.</p>
      <button id="keygate-canvas-ping">Send User Action</button>
      <pre id="keygate-canvas-log">Ready.</pre>
    </main>
    <script>
      const logNode = document.getElementById('keygate-canvas-log');
      const log = (value) => { if (logNode) logNode.textContent = String(value); };
      document.getElementById('keygate-canvas-ping')?.addEventListener('click', () => {
        const ok = window.keygateSendUserAction?.({
          name: 'canvas.ping',
          surfaceId: 'main',
          sourceComponentId: 'keygate-canvas-ping',
          context: { when: Date.now() },
        });
        log(ok ? 'User action dispatched.' : 'Bridge unavailable.');
      });
      window.addEventListener('keygate:canvas-state', (event) => {
        log(JSON.stringify(event.detail ?? {}, null, 2));
      });
    </script>
  </body>
</html>`;
}

function defaultA2uiHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%23111827'/%3E%3Cpath d='M18 16h10v14l12-14h12L39 31l14 17H40L28 34v14H18V16Z' fill='%23f3f4f6'/%3E%3C/svg%3E" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Keygate A2UI</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #111827;
        color: #f3f4f6;
        font: 16px/1.5 "SF Pro Display", "Segoe UI", sans-serif;
      }
      section {
        width: min(560px, calc(100vw - 32px));
        padding: 24px;
        border-radius: 24px;
        border: 1px solid rgba(255,255,255,0.1);
        background: rgba(17, 24, 39, 0.94);
      }
      button {
        margin-right: 12px;
        margin-top: 12px;
        border: 0;
        border-radius: 12px;
        padding: 10px 14px;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <section>
      <h1>A2UI Bridge Ready</h1>
      <p>Use this surface to prototype agent-driven interactive controls.</p>
      <button data-action="hello">Hello</button>
      <button data-action="status">Status</button>
      <button data-action="refresh">Refresh</button>
      <pre id="a2ui-log">Waiting for interaction.</pre>
    </section>
    <script>
      const logNode = document.getElementById('a2ui-log');
      const log = (value) => { if (logNode) logNode.textContent = String(value); };
      document.querySelectorAll('[data-action]').forEach((node) => {
        node.addEventListener('click', () => {
          const name = node.getAttribute('data-action');
          const ok = window.Keygate?.sendUserAction?.({
            name,
            surfaceId: 'a2ui',
            sourceComponentId: 'a2ui.' + name,
            context: { when: Date.now() },
          });
          log(ok ? 'Sent action "' + name + '"' : 'Bridge unavailable.');
        });
      });
      window.addEventListener('keygate:canvas-state', (event) => {
        log(JSON.stringify(event.detail ?? {}, null, 2));
      });
    </script>
  </body>
</html>`;
}

function injectCanvasBridge(html: string, websocketPath: string): string {
  const snippet = `
<script>
(() => {
  let socket = null;
  function postMessageBridge(payload) {
    try {
      const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(raw);
        return true;
      }
      const iosHandler = globalThis.webkit?.messageHandlers?.keygateCanvasA2UIAction;
      if (iosHandler && typeof iosHandler.postMessage === 'function') {
        iosHandler.postMessage(raw);
        return true;
      }
      const androidHandler = globalThis.keygateCanvasA2UIAction;
      if (androidHandler && typeof androidHandler.postMessage === 'function') {
        androidHandler.postMessage(raw);
        return true;
      }
      window.dispatchEvent(new CustomEvent('keygate:bridge-message', { detail: payload }));
      return true;
    } catch {
      return false;
    }
  }

  function sendUserAction(userAction) {
    const id = userAction?.id || globalThis.crypto?.randomUUID?.() || String(Date.now());
    return postMessageBridge({ userAction: { ...userAction, id } });
  }

  globalThis.Keygate = globalThis.Keygate || {};
  globalThis.Keygate.postMessage = postMessageBridge;
  globalThis.Keygate.sendUserAction = sendUserAction;
  globalThis.keygatePostMessage = postMessageBridge;
  globalThis.keygateSendUserAction = sendUserAction;

  try {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const query = location.search || '';
    socket = new WebSocket(proto + '://' + location.host + ${JSON.stringify(websocketPath)} + query);
    socket.onmessage = (event) => {
      const raw = String(event.data || '');
      if (raw === 'reload') {
        location.reload();
        return;
      }
      try {
        const payload = JSON.parse(raw);
        if (payload && typeof payload === 'object') {
          window.dispatchEvent(new CustomEvent('keygate:canvas-state', { detail: payload }));
        }
      } catch {}
    };
  } catch {}
})();
</script>`;

  const index = html.toLowerCase().lastIndexOf('</body>');
  return index >= 0
    ? `${html.slice(0, index)}\n${snippet}\n${html.slice(index)}`
    : `${html}\n${snippet}\n`;
}

function ensureCanvasRoot(rootDir: string): string {
  fsSync.mkdirSync(rootDir, { recursive: true });
  const indexPath = path.join(rootDir, 'index.html');
  if (!fsSync.existsSync(indexPath)) {
    fsSync.writeFileSync(indexPath, defaultCanvasHtml({
      enabled: true,
      rootDir,
      basePath: '',
      a2uiPath: '',
      websocketPath: '',
      liveReload: true,
    }), 'utf8');
  }
  return rootDir;
}

export function createCanvasHostHandler(config: KeygateConfig): CanvasHostHandler {
  const canvasConfig = config.canvas ?? {
    enabled: true,
    rootDir: path.join(config.security.workspacePath, 'canvas'),
    basePath: '/__keygate__/canvas',
    a2uiPath: '/__keygate__/a2ui',
    websocketPath: '/__keygate__/canvas/ws',
    liveReload: true,
  };
  const rootDir = ensureCanvasRoot(path.resolve(canvasConfig.rootDir));
  const wsPath = canvasConfig.websocketPath;
  const basePath = canvasConfig.basePath.replace(/\/+$/, '');
  const a2uiPath = canvasConfig.a2uiPath.replace(/\/+$/, '');
  const sockets = new Map<WebSocket, { sessionId: string; surfaceId: string }>();
  const userActionListeners = new Set<(event: CanvasUserActionEvent) => void | Promise<void>>();
  const wss = new WebSocketServer({ noServer: true });
  const watcher = canvasConfig.liveReload
    ? chokidar.watch(rootDir, { ignoreInitial: true })
    : null;

  wss.on('connection', (ws) => {
    if (!sockets.has(ws)) {
      sockets.set(ws, { sessionId: '', surfaceId: '' });
    }
    ws.on('close', () => sockets.delete(ws));
  });

  watcher?.on('all', () => {
    for (const socket of sockets.keys()) {
      try {
        socket.send('reload');
      } catch {
        // ignore broadcast errors
      }
    }
  });

  async function serveHtml(res: ServerResponse, html: string): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(injectCanvasBridge(html, wsPath));
  }

  return {
    async handleHttpRequest(req, res) {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname.replace(/\/+$/, '') || '/';

      if (pathname === a2uiPath) {
        await serveHtml(res, defaultA2uiHtml());
        return true;
      }

      if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
        return false;
      }

      const relativePath = pathname === basePath
        ? 'index.html'
        : pathname.slice(basePath.length + 1);
      const targetPath = path.resolve(path.join(rootDir, relativePath));
      if (!targetPath.startsWith(rootDir)) {
        res.writeHead(403).end('Forbidden');
        return true;
      }

      try {
        const stat = await fs.stat(targetPath);
        if (!stat.isFile()) {
          res.writeHead(404).end('Not Found');
          return true;
        }
        const content = await fs.readFile(targetPath);
        const isHtml = path.extname(targetPath).toLowerCase() === '.html';
        if (isHtml) {
          await serveHtml(res, content.toString('utf8'));
          return true;
        }
        res.writeHead(200, {
          'Content-Type': guessContentType(targetPath),
          'Cache-Control': 'no-store',
        });
        res.end(content);
        return true;
      } catch {
        res.writeHead(404).end('Not Found');
        return true;
      }
    },
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== wsPath) {
        return false;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const sessionId = url.searchParams.get('sessionId')?.trim() ?? '';
        const surfaceId = url.searchParams.get('surfaceId')?.trim() ?? '';
        sockets.set(ws, { sessionId, surfaceId });
        ws.on('message', (raw) => {
          try {
            const payload = JSON.parse(String(raw)) as Record<string, unknown>;
            const descriptor = sockets.get(ws) ?? { sessionId, surfaceId };
            const action = payload['userAction'];
            if (!descriptor.sessionId || !descriptor.surfaceId || !action || typeof action !== 'object' || Array.isArray(action)) {
              return;
            }
            const event: CanvasUserActionEvent = {
              sessionId: descriptor.sessionId,
              surfaceId: descriptor.surfaceId,
              action: action as Record<string, unknown>,
            };
            for (const listener of userActionListeners) {
              void Promise.resolve(listener(event)).catch(() => {});
            }
          } catch {
            // Ignore malformed bridge messages.
          }
        });
        wss.emit('connection', ws, req);
      });
      return true;
    },
    broadcastState(event) {
      const payload = JSON.stringify({
        type: 'canvas_state',
        sessionId: event.sessionId,
        surfaceId: event.surfaceId,
        path: event.path,
        mode: event.mode,
        state: event.state,
        statusText: event.statusText,
      });
      for (const [socket, descriptor] of sockets.entries()) {
        if (descriptor.sessionId && descriptor.sessionId !== event.sessionId) {
          continue;
        }
        if (descriptor.surfaceId && descriptor.surfaceId !== event.surfaceId) {
          continue;
        }
        try {
          socket.send(payload);
        } catch {
          // Ignore socket send failures.
        }
      }
    },
    onUserAction(listener) {
      userActionListeners.add(listener);
      return () => userActionListeners.delete(listener);
    },
    async close() {
      await watcher?.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function guessContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.js':
    case '.mjs':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}
