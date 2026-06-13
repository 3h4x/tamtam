import { afterAll, afterEach, beforeEach, vi } from 'vitest';
import { enforceTestDatabaseUrl } from '@/__tests__/helpers/guard-database-url';

// Per-worker belt-and-suspenders: re-assert the test DATABASE_URL inside each
// forked worker before any test module loads, so a stray real-pool import can
// never reach a live database even if globalSetup's env propagation changes.
enforceTestDatabaseUrl();

// Leaked fake timers can break Vitest's own throttled task-update timers during
// worker teardown, producing an unhandled "failed to access internal state".
// Discard any pending fake timers before restoring the real ones so a queued
// callback can't fire under a stale clock, then always hand control back to
// real timers. Restoring in beforeEach as well closes the window where a test
// that threw before its own cleanup hook could otherwise leak fake timers into
// the next test or into the runner's trailing task-update flush.
function restoreRealTimers() {
  if (vi.isFakeTimers()) {
    vi.clearAllTimers();
  }
  vi.useRealTimers();
}

beforeEach(() => {
  restoreRealTimers();
});

afterEach(() => {
  restoreRealTimers();
});

afterAll(() => {
  restoreRealTimers();
});
