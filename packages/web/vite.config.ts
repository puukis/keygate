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
        target: 'ws://localhost:18790',
        ws: true,
      },
      // Proxy REST API calls
      '/api': {
        target: 'http://localhost:18790',
        changeOrigin: true,
      },
    },
  },
});
