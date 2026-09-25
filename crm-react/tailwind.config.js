/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        gl: {
          bg: '#0e1418',
          panel: '#16202a',
          panel2: '#1c2a36',
          line: '#263847',
          text: '#e8eef2',
          muted: '#8aa0b0',
          teal: '#14b8a6',
          'teal-d': '#0f766e',
          green: '#22c55e',
          red: '#f43f5e',
          amber: '#f59e0b',
          blue: '#38bdf8',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
