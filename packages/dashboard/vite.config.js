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
    open: true,
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
