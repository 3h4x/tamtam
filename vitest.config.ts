import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'],
    globalSetup: ['./__tests__/global-setup.ts'],
    pool: 'threads',
    maxWorkers: 12,
    silent: 'passed-only',
  },
});
