CREATE TABLE "job_completion_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"kind" text NOT NULL,
	"exit_code" integer,
	"project" text NOT NULL,
	"release_id" text,
	"gh_issue_number" integer,
	"emitted_at" double precision NOT NULL,
	"consumed_by" text,
	"consumed_at" double precision
);
--> statement-breakpoint
CREATE UNIQUE INDEX "job_completion_events_job_id" ON "job_completion_events" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_completion_events_unconsumed" ON "job_completion_events" USING btree ("consumed_by","emitted_at");