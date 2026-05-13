-- The `paused` column on `projects` is added by the runtime bootstrap path
-- in `lib/db/index.ts` so existing databases upgrade cleanly. This migration
-- file is a no-op tracker so drizzle-kit's snapshot chain stays linear; the
-- schema state recorded in `meta/0020_snapshot.json` matches the bootstrapped
-- column. SQLite has no ADD COLUMN IF NOT EXISTS, and a plain ALTER would
-- collide with the bootstrap on every existing install.
SELECT 1;
