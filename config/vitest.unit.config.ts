import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Vitest config for unit tests (services, lib).
 *
 * These tests use vi.mock() and need full module isolation so mocks
 * don't leak between files.  They do NOT touch the real database.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['../tests/setup.ts'],
    include: [
      '../src/services/**/*.test.ts',
      '../src/lib/**/*.test.ts',
    ],
    exclude: [
      'node_modules',
      'dist',
      'ui/**',
    ],
    coverage: {
      provider: 'v8',
      include: ['../src/**/*.ts'],
      exclude: [
        'prisma/**',
        'tests/**',
        'src/types/**',
        '**/types.ts',
        '**/index.ts',
        'src/lib/sentry.ts',
      ],
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: '../coverage',
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Unit tests need full isolation so vi.mock() doesn't leak between files
    pool: 'forks',
    isolate: true,
  },
});
