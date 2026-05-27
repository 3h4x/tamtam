CREATE TABLE IF NOT EXISTS "usage_hourly_snapshot" (
	"id" serial PRIMARY KEY NOT NULL,
	"bucket_ts" double precision NOT NULL,
	"provider" text NOT NULL,
	"window_key" text NOT NULL,
	"utilization_pct" double precision NOT NULL,
	"elapsed_pct" double precision NOT NULL,
	"projected_pct" double precision,
	"pace_margin_pct" double precision NOT NULL,
	"status" text NOT NULL,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"cache_read_tokens" bigint,
	"cache_create_tokens" bigint,
	"job_count" integer,
	"recorded_at" double precision NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_hourly_snapshot_bucket" ON "usage_hourly_snapshot" USING btree ("bucket_ts","provider","window_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_hourly_snapshot_ts" ON "usage_hourly_snapshot" USING btree ("bucket_ts");
