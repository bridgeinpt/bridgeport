import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Vitest config for integration tests (routes, security).
 *
 * These tests use a real SQLite database and must run sequentially in
 * one process (isolate: false, maxWorkers: 1) to avoid data races.
 *
 * Unit tests (src/services/, src/lib/) use vi.mock() and need their own
 * config with isolate: true — see vitest.unit.config.ts.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: [
      'src/routes/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    exclude: [
      'node_modules',
      'dist',
      'ui/**',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'prisma/**',
        'test/**',
        'src/types/**',
        '**/types.ts',
        '**/index.ts',
        'src/lib/sentry.ts',
      ],
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
    },
    // Increase test timeout for integration tests
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Pool settings for test isolation
    // All test files must run sequentially in one process to share the SQLite DB
    pool: 'forks',
    isolate: false,
    maxWorkers: 1,
  },
});
