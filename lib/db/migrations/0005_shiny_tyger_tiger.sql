CREATE TABLE "job_resource_samples" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"sampled_at" double precision NOT NULL,
	"cpu_pct" double precision,
	"rss_kb" integer
);
--> statement-breakpoint
CREATE INDEX "job_resource_samples_job_sampled" ON "job_resource_samples" USING btree ("job_id","sampled_at");