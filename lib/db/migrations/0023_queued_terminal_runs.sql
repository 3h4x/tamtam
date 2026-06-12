CREATE TABLE IF NOT EXISTS "queued_terminal_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project" text NOT NULL,
	"enqueued_at" double precision NOT NULL,
	"payload" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_job_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "queued_terminal_runs_project_enqueued" ON "queued_terminal_runs" ("project","enqueued_at");
