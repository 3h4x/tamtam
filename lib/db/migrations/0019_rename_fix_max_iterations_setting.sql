-- Rename the `review_fix_max_iterations` settings row to
-- `fix_max_iterations`. The cap is now unified across review, test,
-- commit, and the review-driven push leg (see
-- `lib/pipeline/recovery-budget.ts`), so the historical name —
-- which implied "review only" — became misleading.
--
-- Without this migration, an existing install that had explicitly set
-- `review_fix_max_iterations = N` would silently fall through to the
-- new key's default (0 / unlimited) on first read after the rename,
-- because `lib/shared/config.ts:settings parser` no longer accepts the
-- legacy key. Operators who tuned a finite cap to bound a chatty
-- reviewer would lose that protection without warning.
--
-- Cases handled idempotently (the migration only runs once, but
-- different installs reach it from different starting states):
--   A. Only the OLD row exists → copy its value to the new key, drop
--      the old row.
--   B. Only the NEW row exists → no-op.
--   C. BOTH rows exist (server booted with new code before the migrate
--      step landed and wrote a *default* into the new key, while the
--      operator's tuned value still sat under the old key) → promote
--      the old row's value when it represents an operator override
--      (non-default) and the new row still holds the default. Then
--      drop the old row in every both-rows case.
--
-- The default value is `0` (unlimited) — see DEFAULTS.fix_max_iterations
-- in `lib/shared/config.ts`. We treat `0` as "default" for promotion
-- detection. An operator who explicitly set the new key to a non-default
-- value (e.g. via the new code's settings UI before this migration ran)
-- has their choice preserved.

-- Branch 1: copy the old value to the new key when the new key is absent.
INSERT INTO "settings" ("key", "value")
SELECT 'fix_max_iterations', "value"
FROM "settings"
WHERE "key" = 'review_fix_max_iterations'
  AND NOT EXISTS (
    SELECT 1 FROM "settings" WHERE "key" = 'fix_max_iterations'
  );
--> statement-breakpoint

-- Branch 2: when BOTH rows exist, promote the operator-tuned old value
-- only if the new row currently holds the default (`0`) AND the old row
-- holds a non-default value. This rescues the documented race where the
-- new code wrote a default into the new key before the rename migration
-- ran, which would otherwise discard the operator's tuned legacy value
-- in the DELETE below.
UPDATE "settings" AS new_row
SET "value" = old_row."value"
FROM "settings" AS old_row
WHERE new_row."key" = 'fix_max_iterations'
  AND old_row."key" = 'review_fix_max_iterations'
  AND new_row."value" = '0'
  AND old_row."value" <> '0';
--> statement-breakpoint

-- Branch 3 (also clean-up for branch 1+2): drop the orphaned old row.
DELETE FROM "settings"
WHERE "key" = 'review_fix_max_iterations';
