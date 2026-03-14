import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WebChatApp } from './WebChatApp';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WebChatApp />
  </StrictMode>
);
