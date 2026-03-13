import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 18789,
    strictPort: true, // Don't fall back to another port
    proxy: {
      // Proxy WebSocket connections to the backend
      '/ws': {
        target: 'ws://127.0.0.1:18790',
        ws: true,
      },
      // Proxy REST API calls
      '/api': {
        target: 'http://127.0.0.1:18790',
        changeOrigin: true,
      },
    },
  },
});
