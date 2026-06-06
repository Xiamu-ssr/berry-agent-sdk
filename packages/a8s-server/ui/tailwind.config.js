/** @type {import('tailwindcss').Config} */
import colors from 'tailwindcss/colors';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        // Use Tailwind's curated stone palette as our neutral. Avoids
        // hand-maintaining every shade.
        ink: colors.stone,
        // Curated red for accent/destructive. All shades present.
        berry: colors.red,
        // Snow Mountain brand: a cold alpine blue for primary/brand surfaces
        // (nav, brand mark, focus). Sky reads crisp on both light and dark.
        snow: colors.sky,
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      animation: {
        'fade-in': 'fade-in 200ms ease-out',
        'pulse-slow': 'pulse 3s ease-in-out infinite',
        'slide-in': 'slide-in 180ms ease-out',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in': {
          '0%': { opacity: '0', transform: 'translateX(-6px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
      },
    },
  },
  plugins: [],
};
