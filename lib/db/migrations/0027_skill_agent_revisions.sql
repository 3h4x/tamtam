CREATE TABLE IF NOT EXISTS "skill_revisions" (
  "id" serial PRIMARY KEY NOT NULL,
  "entity_id" text NOT NULL,
  "snapshot" text NOT NULL,
  "author" text NOT NULL,
  "note" text,
  "created_at" double precision NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_revisions_entity_created" ON "skill_revisions" ("entity_id","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_revisions" (
  "id" serial PRIMARY KEY NOT NULL,
  "entity_id" text NOT NULL,
  "snapshot" text NOT NULL,
  "author" text NOT NULL,
  "note" text,
  "created_at" double precision NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_revisions_entity_created" ON "agent_revisions" ("entity_id","created_at");
