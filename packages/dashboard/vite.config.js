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
  define: {
    // Required for @hashgraph/sdk to work in the browser
    'process.env': {},
    global: 'globalThis',
  },
  server: {
    port: 5173,
    open: true,
  },
});
