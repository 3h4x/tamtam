ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "daily_spend_cap_usd" double precision,
  ADD COLUMN IF NOT EXISTS "release_spend_cap_usd" double precision;
