import { useState, useEffect, useRef, useCallback } from 'react';

interface UseWebSocketResult {
  send: (data: object) => boolean;
  connected: boolean;
  connecting: boolean;
}

interface UseWebSocketOptions {
  enabled?: boolean;
  reconnectDelayMs?: number;
  onDisconnected?: (details: { everConnected: boolean }) => void;
}

export function useWebSocket(
  url: string,
  onMessage: (data: Record<string, unknown>) => void,
  options: UseWebSocketOptions = {},
): UseWebSocketResult {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(options.enabled !== false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | undefined>(undefined);
  const connectTimeoutRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(false);
  const enabledRef = useRef(options.enabled !== false);
  const everConnectedRef = useRef(false);
  const onMessageRef = useRef(onMessage);
  const onDisconnectedRef = useRef(options.onDisconnected);
  const reconnectDelayMs = options.reconnectDelayMs ?? 3000;

  // Keep onMessage ref updated
  onMessageRef.current = onMessage;
  onDisconnectedRef.current = options.onDisconnected;
  enabledRef.current = options.enabled !== false;

  const connect = useCallback(() => {
    if (!mountedRef.current || !enabledRef.current) {
      return;
    }

    setConnecting(true);

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) {
        ws.close();
        return;
      }
      console.log('WebSocket connected');
      everConnectedRef.current = true;
      setConnected(true);
      setConnecting(false);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as Record<string, unknown>;
        onMessageRef.current(data);
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    ws.onclose = () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
      }

      if (!mountedRef.current) {
        return;
      }

      console.log('WebSocket disconnected');
      setConnected(false);
      setConnecting(false);
      onDisconnectedRef.current?.({ everConnected: everConnectedRef.current });

      reconnectTimeoutRef.current = window.setTimeout(() => {
        if (!mountedRef.current || !enabledRef.current) {
          return;
        }
        console.log('Attempting to reconnect...');
        connect();
      }, reconnectDelayMs);
    };

    ws.onerror = (error) => {
      if (!mountedRef.current) {
        return;
      }
      console.error('WebSocket error:', error);
    };
  }, [reconnectDelayMs, url]);

  useEffect(() => {
    mountedRef.current = true;
    if (options.enabled !== false) {
      setConnecting(true);
      connectTimeoutRef.current = window.setTimeout(connect, 0);
    } else {
      setConnected(false);
      setConnecting(false);
    }

    return () => {
      mountedRef.current = false;

      if (connectTimeoutRef.current !== undefined) {
        clearTimeout(connectTimeoutRef.current);
      }

      if (reconnectTimeoutRef.current !== undefined) {
        clearTimeout(reconnectTimeoutRef.current);
      }

      if (wsRef.current) {
        const ws = wsRef.current;
        wsRef.current = null;

        if (ws.readyState === WebSocket.CONNECTING) {
          // Avoid closing during CONNECTING (which logs a browser-level error).
          // Instead, close immediately after the handshake completes.
          ws.onopen = () => ws.close();
          ws.onmessage = null;
          ws.onerror = null;
          ws.onclose = null;
          return;
        }

        // Prevent reconnect logic from firing when we intentionally close/unmount.
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;

        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      }
    };
  }, [connect, options.enabled]);

  const send = useCallback((data: object): boolean => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
      return true;
    }
    console.warn('WebSocket not connected, message not sent');
    return false;
  }, []);

  return { send, connected, connecting };
}
