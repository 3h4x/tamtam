-- Add per-job lines-of-code delta for agent fruitfulness tracking.
--
-- `modified_files` already captures which files an agent changed (as a JSON
-- array). To rank "did this agent actually do anything useful" the
-- orchestrator also needs the magnitude of the change — a one-line typo fix
-- and a 200-line feature both show as `files=1`, but the orchestrator should
-- treat them very differently when deciding whether the agent is worth
-- boosting again.
--
-- Populated by `finalizeAgentRunReport` via `git diff --numstat`. Nullable so
-- older agent runs (and non-agent jobs) stay valid without backfill.

ALTER TABLE "jobs" ADD COLUMN "lines_added" integer;
--> statement-breakpoint

ALTER TABLE "jobs" ADD COLUMN "lines_removed" integer;
