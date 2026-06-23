ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "setup_complete" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "setup_state" text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
UPDATE "projects" SET "setup_complete" = true WHERE "setup_state" = '{}';
