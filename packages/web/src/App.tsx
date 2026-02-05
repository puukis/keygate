import { useState, useEffect, useRef, useCallback } from 'react';
import { ChatView } from './components/ChatView';
import { LiveActivityLog } from './components/LiveActivityLog';
import { SecurityBadge } from './components/SecurityBadge';
import { ConfirmationModal } from './components/ConfirmationModal';
import { useWebSocket } from './hooks/useWebSocket';
import './App.css';

export type SecurityMode = 'safe' | 'spicy';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface ToolEvent {
  id: string;
  type: 'start' | 'end';
  tool: string;
  args?: Record<string, unknown>;
  result?: { success: boolean; output: string; error?: string };
  timestamp: Date;
}

export interface PendingConfirmation {
  id: string;
  prompt: string;
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [mode, setMode] = useState<SecurityMode>('safe');
  const [spicyEnabled, setSpicyEnabled] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const streamBufferRef = useRef('');

  const handleMessage = useCallback((data: Record<string, unknown>) => {
    const type = data['type'] as string;

    switch (type) {
      case 'connected':
        setMode(data['mode'] as SecurityMode);
        setSpicyEnabled(data['spicyEnabled'] as boolean);
        break;

      case 'message_received':
        setIsStreaming(true);
        streamBufferRef.current = '';
        break;

      case 'chunk':
        streamBufferRef.current += data['content'] as string;
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant' && last.id === 'streaming') {
            return [...prev.slice(0, -1), { ...last, content: streamBufferRef.current }];
          }
          return [...prev, {
            id: 'streaming',
            role: 'assistant',
            content: streamBufferRef.current,
            timestamp: new Date(),
          }];
        });
        break;

      case 'stream_end':
        setIsStreaming(false);
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last?.id === 'streaming') {
            return [...prev.slice(0, -1), { ...last, id: crypto.randomUUID() }];
          }
          return prev;
        });
        break;

      case 'message':
        setIsStreaming(false);
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: data['content'] as string,
          timestamp: new Date(),
        }]);
        break;

      case 'tool_start':
        setToolEvents(prev => [...prev, {
          id: crypto.randomUUID(),
          type: 'start',
          tool: data['tool'] as string,
          args: data['args'] as Record<string, unknown>,
          timestamp: new Date(),
        }]);
        break;

      case 'tool_end':
        setToolEvents(prev => [...prev, {
          id: crypto.randomUUID(),
          type: 'end',
          tool: data['tool'] as string,
          result: data['result'] as ToolEvent['result'],
          timestamp: new Date(),
        }]);
        break;

      case 'confirm_request':
        setPendingConfirmation({
          id: crypto.randomUUID(),
          prompt: data['prompt'] as string,
        });
        break;

      case 'mode_changed':
        setMode(data['mode'] as SecurityMode);
        break;

      case 'session_cleared':
        setMessages([]);
        setToolEvents([]);
        break;
    }
  }, []);

  const { send, connected, connecting } = useWebSocket('ws://localhost:18790', handleMessage);

  const handleSendMessage = useCallback((content: string) => {
    if (!content.trim() || !connected) return;

    setMessages(prev => [...prev, {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: new Date(),
    }]);

    send({ type: 'message', content });
  }, [connected, send]);

  const handleConfirm = useCallback((confirmed: boolean) => {
    send({ type: 'confirm_response', confirmed });
    setPendingConfirmation(null);
  }, [send]);

  const handleModeChange = useCallback((newMode: SecurityMode) => {
    if (newMode === 'spicy' && !spicyEnabled) {
      alert('Spicy mode is not enabled. Re-run the installer and accept the risk.');
      return;
    }
    send({ type: 'set_mode', mode: newMode });
  }, [send, spicyEnabled]);

  const handleClearSession = useCallback(() => {
    send({ type: 'clear_session' });
  }, [send]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1 className="logo">⚡ Keygate</h1>
          <SecurityBadge
            mode={mode}
            spicyEnabled={spicyEnabled}
            onModeChange={handleModeChange}
          />
        </div>
        <div className="header-right">
          <div className={`connection-status ${connected ? 'connected' : connecting ? 'connecting' : 'disconnected'}`}>
            <span className="status-dot" />
            {connected ? 'Connected' : connecting ? 'Connecting...' : 'Disconnected'}
          </div>
          <button className="btn-secondary" onClick={handleClearSession}>
            Clear Chat
          </button>
        </div>
      </header>

      <main className="app-main">
        <ChatView
          messages={messages}
          onSendMessage={handleSendMessage}
          isStreaming={isStreaming}
          disabled={!connected}
        />
        <LiveActivityLog events={toolEvents} />
      </main>

      {pendingConfirmation && (
        <ConfirmationModal
          prompt={pendingConfirmation.prompt}
          onConfirm={() => handleConfirm(true)}
          onCancel={() => handleConfirm(false)}
        />
      )}
    </div>
  );
}

export default App;
