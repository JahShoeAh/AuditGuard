/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        guard: {
          green: '#00ff88',
          blue: '#00b4d8',
          purple: '#7b2ff7',
          red: '#ff3860',
          yellow: '#ffd700',
          dark: '#0a0e17',
          panel: '#111827',
          border: '#1f2937',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};
