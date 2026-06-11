import { afterAll, afterEach, vi } from 'vitest';
import { enforceTestDatabaseUrl } from '@/__tests__/helpers/guard-database-url';

// Per-worker belt-and-suspenders: re-assert the test DATABASE_URL inside each
// forked worker before any test module loads, so a stray real-pool import can
// never reach a live database even if globalSetup's env propagation changes.
enforceTestDatabaseUrl();

// Leaked fake timers can break Vitest's own throttled task-update timers during
// worker teardown, producing an unhandled "failed to access internal state".
afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  vi.useRealTimers();
});
