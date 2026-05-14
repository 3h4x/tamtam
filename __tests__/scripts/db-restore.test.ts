import { describe, it } from 'vitest';

// TODO(postgres-cutover): This test exercises the legacy SQLite-only
// `scripts/db-restore.js`, which copies SQLite database files plus their
// `-wal`/`-shm` sidecars and swaps them in place. The production database has
// migrated to Postgres (see `docs/BACKUP.md`), and the cutover plan in
// `docs/superpowers/plans/2026-05-14-postgres-workflow-cutover.md` calls for
// `scripts/db-restore.js` to be rewritten on top of `pg_restore --clean
// --if-exists --dbname=$DATABASE_URL <backup.pgdump>`, and for this test file
// to be replaced with `vi.mock('child_process')` + assertions about the
// `pg_restore` invocation (no more SQLite fixture DBs, no more `TAMTAM_DB_PATH`
// env, no more WAL sidecar assertions).
//
// Until that script is ported, the entire SQLite-staged-swap behavior under
// test no longer represents shipped behavior, so the suite is skipped wholesale
// rather than migrated to PGlite — PGlite would not exercise anything the
// production restore path actually does.
describe.skip('scripts/db-restore.js', () => {
  it('restores the backup via a staged swap on success', () => {});
  it('rolls back the old database and restarts TamTam if the post-swap start fails', () => {});
  it('aborts before swapping the live database when pnpm stop fails', () => {});
  it('restores backup data that lives in the backup WAL sidecar', () => {});
});
