-- Irreversible: removes the obsolete per-project PR workflow flag. Branch-derived
-- push/PR behavior now replaces it, so no data backfill is needed.
ALTER TABLE `projects` DROP COLUMN `pr_workflow_enabled`;
