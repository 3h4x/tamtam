-- The `release_deadline_at` column on `jobs` is added by the runtime bootstrap
-- path in `lib/db/index.ts` and by the standalone `pnpm db:migrate` wrapper in
-- `scripts/db-migrate.js`, so existing databases upgrade cleanly without
-- relying on a later app boot. This migration file stays a no-op tracker so
-- drizzle-kit's snapshot chain remains linear; SQLite has no ADD COLUMN IF NOT
-- EXISTS, and a plain ALTER here would collide with already-bootstrapped DBs.
SELECT 1;
