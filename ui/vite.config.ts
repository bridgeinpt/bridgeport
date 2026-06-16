import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Vite 8 is Rolldown-backed, so manualChunks lives under rolldownOptions
    // (not rollupOptions). Function form is used because it's the safest way
    // to group heavy third-party deps into separate vendor chunks. Combined
    // with the route-level code splitting in App.tsx, this keeps the initial
    // JS payload small and resolves the single-bundle chunk-size warning.
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[\\/]node_modules[\\/](recharts|d3-|internmap|victory-vendor|decimal\.js-light)/.test(id)) {
            return 'charts';
          }
          if (/[\\/]node_modules[\\/]@xyflow[\\/]/.test(id)) return 'flow';
          if (/[\\/]node_modules[\\/](@uiw[\\/]react-codemirror|@codemirror[\\/]|@lezer[\\/]|codemirror)/.test(id)) {
            return 'codemirror';
          }
          if (/[\\/]node_modules[\\/](@radix-ui[\\/]|cmdk)/.test(id)) return 'radix';
          if (/[\\/]node_modules[\\/]@sentry/.test(id)) return 'sentry';
          if (/[\\/]node_modules[\\/](react-router|react-router-dom|react-dom|react)[\\/]/.test(id)) {
            return 'react-vendor';
          }
        },
      },
    },
  },
});
