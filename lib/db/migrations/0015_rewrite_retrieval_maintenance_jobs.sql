-- Follow-up to 0014: rewrite the historical jobs.kind column.
-- 0014 successfully renamed/dropped the system agent rows but the
-- companion UPDATE on the jobs table didn't take effect on the live
-- database (drizzle's migration tracking committed 0014 with only the
-- agents-side changes applied). Splitting the jobs rewrite into its
-- own migration sidesteps that and is idempotent regardless: re-running
-- it on an already-converted DB matches zero rows.

UPDATE "jobs"
SET "kind" = 'agent:documentation-reindex-vectors'
WHERE "kind" = 'agent:retrieval-maintenance';
