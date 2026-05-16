CREATE TABLE "pipeline_lock_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"project" text NOT NULL,
	"released_by_job_id" text,
	"reason" text NOT NULL,
	"emitted_at" double precision NOT NULL,
	"consumed_by" text,
	"consumed_at" double precision
);
--> statement-breakpoint
CREATE INDEX "pipeline_lock_events_unconsumed" ON "pipeline_lock_events" USING btree ("consumed_by","emitted_at");