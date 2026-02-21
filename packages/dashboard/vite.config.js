import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@sdk': path.resolve(__dirname, '../sdk'),
    },
  },
  server: {
    port: 5173,
    open: process.env.DASHBOARD_OPEN === 'true',
    proxy: {
      '/hedera-rpc': {
        target: 'https://testnet.hashio.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/hedera-rpc/, '/api'),
      },
      // Reports API — must be listed before /api so its prefix wins (first-match)
      '/api/reports': {
        target: `http://localhost:${process.env.API_PORT ?? 3002}`,
        changeOrigin: true,
      },
      // Events API (packages/events-api — port 4000, started by npm run dev:all)
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react':   ['react', 'react-dom'],
          'vendor-ethers':  ['ethers'],
          'vendor-motion':  ['framer-motion'],
          'vendor-zustand': ['zustand'],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});
