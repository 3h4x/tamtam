-- Rename the `retrieval-maintenance` system agent to
-- `documentation-reindex-vectors` and bump rows still using the previous
-- default schedule to 16h. The previous name was vague and the previous
-- 1h cadence ran far more often than the underlying corpus changes
-- warrant. Agent IDs follow
-- `system:<project>:<name>`, so the id needs the same rewrite. Job
-- rows carry the old kind in their `kind` column
-- (`agent:retrieval-maintenance`) — rewrite those too so the run
-- history stays linked to the renamed agent. Preserve operator-edited
-- schedules because schedule is a mutable field in the agents UI.

UPDATE "agents"
SET
  "id" = REPLACE("id", ':retrieval-maintenance', ':documentation-reindex-vectors'),
  "name" = 'documentation-reindex-vectors',
  "schedule" = CASE WHEN "schedule" = '1h' THEN '16h' ELSE "schedule" END
WHERE "kind" = 'system' AND "name" = 'retrieval-maintenance';
--> statement-breakpoint

UPDATE "jobs"
SET "kind" = 'agent:documentation-reindex-vectors'
WHERE "kind" = 'agent:retrieval-maintenance';
--> statement-breakpoint

-- Carry over the user-dismissed marker if any project explicitly killed
-- the old system agent — we don't want it to silently re-seed.
UPDATE "settings"
SET "key" = REPLACE("key", ':retrieval-maintenance', ':documentation-reindex-vectors')
WHERE "key" LIKE 'system_agent_dismissed:%:retrieval-maintenance';
