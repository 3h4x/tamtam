-- Rename the `retrieval-maintenance` system agent to
-- `documentation-reindex-vectors` and drop the now-vestigial 1h row.
-- The previous name was vague and the previous 1h cadence ran far more
-- often than the underlying corpus changes warrant.
--
-- Boot order quirk: `seedSystemAgents` runs on rebuild before this
-- migration is applied (TamTam doesn't auto-run app migrations at
-- boot), which leaves both the old row and the freshly-seeded new row
-- in the table. A straight UPDATE on the PK would collide. Two
-- strategies, depending on whether the new row exists yet:
--   * If only the OLD row exists (fresh DB never touched by new code):
--     rename it in place, preserving any operator-edited schedule
--     except for the stale `1h` default.
--   * If BOTH rows exist (a rebuild already inserted the new row):
--     keep the new row and delete the orphaned old one.
-- The two branches are expressed as separate idempotent statements
-- below; whichever applies on the target DB does the right thing.
--
-- Job rows carry the old kind in their `kind` column
-- (`agent:retrieval-maintenance`) — rewrite those so the run history
-- stays linked to the renamed agent.

-- Branch 1: in-place rename when no collision exists.
UPDATE "agents"
SET
  "id" = REPLACE("id", ':retrieval-maintenance', ':documentation-reindex-vectors'),
  "name" = 'documentation-reindex-vectors',
  "schedule" = CASE WHEN "schedule" = '1h' THEN '16h' ELSE "schedule" END
WHERE "kind" = 'system'
  AND "name" = 'retrieval-maintenance'
  AND NOT EXISTS (
    SELECT 1 FROM "agents" AS twin
    WHERE twin."kind" = 'system'
      AND twin."name" = 'documentation-reindex-vectors'
      AND twin."project" = "agents"."project"
  );
--> statement-breakpoint

-- Branch 2: drop the orphaned old row when the new one already exists.
DELETE FROM "agents"
WHERE "kind" = 'system'
  AND "name" = 'retrieval-maintenance';
--> statement-breakpoint

-- Rewrite historical job-kind so run history stays linked under the new name.
UPDATE "jobs"
SET "kind" = 'agent:documentation-reindex-vectors'
WHERE "kind" = 'agent:retrieval-maintenance';
--> statement-breakpoint

-- Carry over the user-dismissed marker if any project explicitly killed
-- the old system agent — we don't want it to silently re-seed.
UPDATE "settings"
SET "key" = REPLACE("key", ':retrieval-maintenance', ':documentation-reindex-vectors')
WHERE "key" LIKE 'system_agent_dismissed:%:retrieval-maintenance'
  AND NOT EXISTS (
    SELECT 1 FROM "settings" AS twin
    WHERE twin."key" = REPLACE("settings"."key", ':retrieval-maintenance', ':documentation-reindex-vectors')
  );
--> statement-breakpoint

-- Drop any remaining old-name dismissal markers superseded by the new ones
-- (handles the case where both keys exist from a partial pre-migration state).
DELETE FROM "settings"
WHERE "key" LIKE 'system_agent_dismissed:%:retrieval-maintenance';
