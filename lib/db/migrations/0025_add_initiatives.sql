CREATE TABLE IF NOT EXISTS "initiatives" (
  "id" serial PRIMARY KEY NOT NULL,
  "project" text NOT NULL,
  "source" text NOT NULL,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "rationale" text NOT NULL,
  "prompt" text NOT NULL,
  "score" double precision DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'proposed' NOT NULL,
  "dedup_key" text NOT NULL,
  "release_id" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "cooldown_until" double precision,
  "created_at" double precision NOT NULL,
  "updated_at" double precision NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "initiatives_project_dedup_key" ON "initiatives" ("project","dedup_key");
