import { defineConfig } from 'vitest/config';
import path from 'path';

const isCi = process.env.CI === 'true';

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
    maxWorkers: isCi ? 4 : 12,
    hookTimeout: isCi ? 30000 : 10000,
    testTimeout: 30000,
    teardownTimeout: 10000,
    silent: 'passed-only',
  },
});
