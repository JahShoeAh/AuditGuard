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
