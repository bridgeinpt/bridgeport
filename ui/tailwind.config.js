/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
          800: '#075985',
          900: '#0c4a6e',
        },
        burgundy: {
          500: '#a82222',
          600: '#8f1a1a',
          700: '#7D1111',
          800: '#6a0f0f',
          900: '#4d0b0b',
        },
      },
    },
  },
  plugins: [],
};
