import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'backend',
      include: [
        'src/**/*.test.ts',
        'test/**/*.test.ts',
      ],
      exclude: [
        'test/migrations/**',
        'node_modules',
        'dist',
        'ui/**',
      ],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'system',
      include: [
        'test/migrations/**/*.test.ts',
      ],
    },
  },
  {
    extends: './ui/vitest.config.ts',
    test: {
      name: 'frontend',
      root: './ui',
    },
  },
]);
