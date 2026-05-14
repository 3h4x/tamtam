import { defineConfig } from '@playwright/test';
import { join } from 'path';

const shimBinDir = join(__dirname, 'e2e', 'pipeline', 'mocks', 'bin');
const E2E_BASE = '/tmp/tamtam-e2e-pipeline';
const codexBin = join(__dirname, 'e2e', 'pipeline', 'mocks', 'codex-bin.js');

export default defineConfig({
  testDir: './e2e/pipeline',
  // Individual pipeline tests can take up to 2 minutes (review → fix → review chain).
  timeout: 150_000,
  retries: 0,
  // Run specs sequentially so state files don't collide.
  workers: 1,
  globalSetup: './e2e/pipeline/global-setup.ts',
  globalTeardown: './e2e/pipeline/global-teardown.ts',
  use: {
    baseURL: 'http://localhost:1338',
  },
  projects: [{ name: 'pipeline' }],
  webServer: {
    // Start a dedicated Next.js dev server on port 1338 so pipeline tests run
    // against a clean DB and don't interfere with the production server on 1337.
    command: 'node e2e/pipeline/db-admin.mjs prepare && pnpm exec next dev --port 1338 --hostname 127.0.0.1',
    url: 'http://localhost:1338/api/health',
    // Allow up to 3 minutes for Next.js compilation on first start.
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      // Pipeline e2e expects an isolated Postgres database, created by the
      // webServer prepare step and dropped by globalTeardown. Override via
      // E2E_DATABASE_URL when your local Postgres lives elsewhere.
      DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://tamtam:tamtam@localhost:5432/tamtam_e2e_pipeline',
      // Run the probe sweep every 500 ms so PM2 job completion is picked up quickly.
      TAMTAM_PROBE_INTERVAL_MS: '500',
      TAMTAM_PR_WAIT_POLL_MS: '250',
      PORT: '1338',
      HOSTNAME: '127.0.0.1',
      // Prepend our shim bin dir so git/gh calls are intercepted.
      PATH: `${shimBinDir}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
      // Shim state base directory (used by git + gh shims for inline server calls).
      TAMTAM_E2E_SHIM_DIR: `${E2E_BASE}/shim-state`,
      // Used by Codex shim e2e tests so scripts/codex-shim.js never calls real Codex.
      CODEX_BIN: codexBin,
    },
  },
});
