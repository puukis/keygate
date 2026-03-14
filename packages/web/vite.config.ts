import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        webchat: path.resolve(__dirname, 'webchat.html'),
      },
    },
  },
  server: {
    port: 18789,
    strictPort: true, // Don't fall back to another port
    proxy: {
      // Proxy WebSocket connections to the backend
      '/ws': {
        target: 'ws://127.0.0.1:18790',
        ws: true,
      },
      '/webchat/ws': {
        target: 'ws://127.0.0.1:18790',
        ws: true,
      },
      '/__keygate__/canvas/ws': {
        target: 'ws://127.0.0.1:18790',
        ws: true,
      },
      // Proxy REST API calls
      '/api': {
        target: 'http://127.0.0.1:18790',
        changeOrigin: true,
      },
      '/webchat': {
        target: 'http://127.0.0.1:18790',
        changeOrigin: true,
      },
      '/__keygate__': {
        target: 'http://127.0.0.1:18790',
        changeOrigin: true,
      },
    },
  },
});
