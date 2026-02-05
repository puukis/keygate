import { useState, useEffect, useRef, useCallback } from 'react';

interface UseWebSocketResult {
  send: (data: object) => void;
  connected: boolean;
  connecting: boolean;
}

export function useWebSocket(
  url: string,
  onMessage: (data: Record<string, unknown>) => void
): UseWebSocketResult {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | undefined>(undefined);
  const connectTimeoutRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(false);
  const onMessageRef = useRef(onMessage);

  // Keep onMessage ref updated
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    if (!mountedRef.current) {
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

      // Reconnect after 3 seconds
      reconnectTimeoutRef.current = window.setTimeout(() => {
        if (!mountedRef.current) {
          return;
        }
        console.log('Attempting to reconnect...');
        connect();
      }, 3000);
    };

    ws.onerror = (error) => {
      if (!mountedRef.current) {
        return;
      }
      console.error('WebSocket error:', error);
    };
  }, [url]);

  useEffect(() => {
    mountedRef.current = true;
    connectTimeoutRef.current = window.setTimeout(connect, 0);

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
  }, [connect]);

  const send = useCallback((data: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    } else {
      console.warn('WebSocket not connected, message not sent');
    }
  }, []);

  return { send, connected, connecting };
}
