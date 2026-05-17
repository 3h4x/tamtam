-- Recovery migration: the `agents.runner` column was added to lib/db/schema.ts
-- in commit 62b304c but the generated 0006 migration is comment-only — no
-- DDL ever landed. Production DBs queried by builds that include the
-- `runner` column in the SELECT list crash with 42703 "column does not
-- exist". This migration adds the column idempotently so existing rows get
-- the schema default ('pm2') and the column survives boot.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "runner" text NOT NULL DEFAULT 'pm2';
