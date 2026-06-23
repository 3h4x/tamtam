import { afterAll, afterEach, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { enforceTestDatabaseUrl } from '@/__tests__/helpers/guard-database-url';

// Per-worker belt-and-suspenders: re-assert the test DATABASE_URL inside each
// forked worker before any test module loads, so a stray real-pool import can
// never reach a live database even if globalSetup's env propagation changes.
enforceTestDatabaseUrl();

// Tripwire for real-pool leaks.
//
// When a test (or a background async task it spawns) uses the real `@/lib/db`
// pool instead of a mock/PGlite, that pool's connection string is the guard URL
// (`…tamtam_test…`). In CI this surfaces as an anonymous, FLAKY
// `role "tamtam_test" does not exist` with no clue which test leaked — the leak
// fires from a timer/promise that resolves after its test, so the failure can't
// be attributed. Patch pg.Pool so any query/connect against the guard URL logs
// a stack identifying the caller. Pools that target a real test database (the
// `db` project's per-test Postgres) don't match and pass through untouched, so
// this is a no-op for correct tests and a named signpost for a leak.
const GUARD_POOL_RE = /tamtam_test/;
const isGuardPool = (p: unknown): boolean => {
  try {
    const cs = (p as { options?: { connectionString?: string } })?.options?.connectionString ?? '';
    return GUARD_POOL_RE.test(cs);
  } catch {
    return false;
  }
};
// Cast both methods to a single generic function shape so one wrapper assigns
// to either slot (`query` and `connect` have unrelated signatures otherwise).
const proto = Pool.prototype as unknown as Record<'query' | 'connect', (...args: unknown[]) => unknown> & {
  __tamtamGuardPoolPatched?: boolean;
};
if (!proto.__tamtamGuardPoolPatched) {
  proto.__tamtamGuardPoolPatched = true;
  (['query', 'connect'] as const).forEach((method) => {
    const original = proto[method];
    proto[method] = function patched(this: unknown, ...args: unknown[]) {
      if (isGuardPool(this)) {
        console.error(
          `[db-guard] real pg pool .${method}() ran against the test guard URL — a test leaked the real @/lib/db pool. Mock @/lib/db or use createTestPgDb. Origin:\n${new Error().stack}`,
        );
      }
      return original.apply(this, args);
    };
  });
}

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
