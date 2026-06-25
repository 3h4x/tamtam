CREATE TABLE IF NOT EXISTS "test_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "project" text NOT NULL,
  "job_id" text NOT NULL,
  "test_id" text NOT NULL,
  "framework" text NOT NULL,
  "commit_sha" text,
  "status" text NOT NULL,
  "first_seen_at" double precision NOT NULL,
  "finished_at" double precision NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_runs_project_test" ON "test_runs" USING btree ("project","test_id","finished_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_runs_job" ON "test_runs" USING btree ("job_id");
