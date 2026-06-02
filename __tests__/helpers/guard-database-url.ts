// Hard guard against tests touching a live database.
//
// Vitest loads `.env` into process.env, so DATABASE_URL during a test run is
// usually the developer's LIVE connection string. DB-backed tests use PGlite
// (helpers/test-db.ts) and redirect @/lib/db with `vi.doMock`, but `doMock`
// only affects imports made AFTER it runs — a module imported statically (or
// before its mock installs) keeps the real `db`, whose pool points at that
// live URL. A single stray query/DDL then runs against production. This is how
// running `pnpm test` (directly or via the pre-push hook) dropped the live
// server's schema out from under the running PM2 process.
//
// `enforceTestDatabaseUrl` forces an isolated, non-existent test target unless
// DATABASE_URL is already an obvious `_test` database. Properly-mocked tests
// never open the real pool (pg connects lazily), so this is a no-op for them;
// only an accidental real-pool user is affected, and it now fails loudly
// (connection refused) instead of mutating a live database.
//
// Called from BOTH the Vitest globalSetup (once, in the main process, before
// forks spawn and inherit env) and a setupFiles module (once per worker) so a
// stray import can never reach production even if env propagation changes.

// Intentionally points at a database/role that don't exist in normal dev/CI.
export const SAFE_TEST_DATABASE_URL = 'postgres://tamtam_test@localhost:5432/tamtam_test';

// A URL is safe only if it targets a database whose name ends in `_test`.
// Anything else — including the developer's live `…/tamtam` — is production.
export function isTestDatabaseUrl(url: string): boolean {
  try {
    const dbName = new URL(url).pathname.replace(/^\//, '');
    return /_test$/.test(dbName);
  } catch {
    return false;
  }
}

export function enforceTestDatabaseUrl(): void {
  const url = process.env.DATABASE_URL;
  if (!url || !isTestDatabaseUrl(url)) {
    process.env.DATABASE_URL = SAFE_TEST_DATABASE_URL;
  }
}
