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
  const reconnectTimeoutRef = useRef<number>();
  const onMessageRef = useRef(onMessage);

  // Keep onMessage ref updated
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    setConnecting(true);

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
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
      console.log('WebSocket disconnected');
      setConnected(false);
      setConnecting(false);
      wsRef.current = null;

      // Reconnect after 3 seconds
      reconnectTimeoutRef.current = window.setTimeout(() => {
        console.log('Attempting to reconnect...');
        connect();
      }, 3000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }, [url]);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      wsRef.current?.close();
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
