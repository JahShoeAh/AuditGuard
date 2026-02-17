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
          green: '#10B981',
          cyan: '#06B6D4',
          blue: '#00b4d8',
          purple: '#8B5CF6',
          red: '#EF4444',
          amber: '#F59E0B',
          gold: '#F5A623',
          dark: '#0A0E17',
          panel: '#111827',
          card: '#151C2C',
          border: 'rgba(255, 255, 255, 0.08)',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
        sans: ['Outfit', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        'scan-sweep': {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
        'radar-ring': {
          '0%': { transform: 'scale(0.3)', opacity: '0.8' },
          '100%': { transform: 'scale(1.8)', opacity: '0' },
        },
        'slide-down': {
          '0%': { transform: 'translateY(-12px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        'stat-bump': {
          '0%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.15)' },
          '100%': { transform: 'scale(1)' },
        },
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'scan-sweep': 'scan-sweep 3s linear infinite',
        'radar-ring': 'radar-ring 2s ease-out infinite',
        'slide-down': 'slide-down 0.3s ease-out',
        'stat-bump': 'stat-bump 0.3s ease-out',
      },
    },
  },
  plugins: [],
};
