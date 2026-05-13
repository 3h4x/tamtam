CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"project" text NOT NULL,
	"skill_ids" text DEFAULT '[]' NOT NULL,
	"model" text DEFAULT 'normal' NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"schedule" text,
	"runner" text DEFAULT 'pm2' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"doc_paths" text DEFAULT '[]' NOT NULL,
	"provider" text,
	"prerequisite_command" text,
	"created_at" double precision NOT NULL,
	"updated_at" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gh_issues_cache" (
	"project" text PRIMARY KEY NOT NULL,
	"repo" text NOT NULL,
	"prs" text DEFAULT '[]' NOT NULL,
	"issues" text DEFAULT '[]' NOT NULL,
	"fetched_at" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gh_status" (
	"project" text PRIMARY KEY NOT NULL,
	"release_tag" text,
	"ci" text,
	"ci_failed_url" text,
	"head_sha" text,
	"local_head_sha" text,
	"fetched_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"project" text NOT NULL,
	"kind" text NOT NULL,
	"prompt" text,
	"pid" integer NOT NULL,
	"log_path" text,
	"started_at" double precision NOT NULL,
	"finished_at" double precision,
	"exit_code" integer,
	"seen" boolean DEFAULT false,
	"duration_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_create_tokens" integer,
	"session_id" text,
	"user_prompt" text,
	"context_meta" text,
	"parent_job_id" text,
	"gh_issue_number" integer,
	"gh_issue_repo" text,
	"gh_issue_title" text,
	"log_pruned" boolean DEFAULT false,
	"verdict" text,
	"cost_usd" double precision,
	"model" text,
	"release_id" text,
	"aborted_at" double precision,
	"prompt_bytes" integer,
	"work_summary" text,
	"modified_files" text,
	"provider" text
);
--> statement-breakpoint
CREATE TABLE "maintenance_status" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"last_sent_at" bigint NOT NULL,
	"suppressed_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ollama_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" double precision NOT NULL,
	"model" text NOT NULL,
	"project" text,
	"source_kind" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_locks" (
	"project" text PRIMARY KEY NOT NULL,
	"locked_by_job_id" text NOT NULL,
	"acquired_at" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"name" text PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"enabled" boolean DEFAULT false,
	"github" text,
	"priority" text,
	"custom_actions" text,
	"test_command" text,
	"tests_disabled" boolean DEFAULT false,
	"review_disabled" boolean DEFAULT false,
	"test_cron_enabled" boolean DEFAULT false,
	"test_cron_schedule" text,
	"auto_commit_enabled" boolean DEFAULT false,
	"auto_push_enabled" boolean DEFAULT false,
	"auto_pr_merge_enabled" boolean DEFAULT false,
	"release_after_run" boolean DEFAULT false,
	"issue_auto_branch" boolean DEFAULT true,
	"last_push_error" text,
	"last_push_at" double precision,
	"review_prompt_addendum" text,
	"fix_prompt_addendum" text,
	"website" text,
	"qa_url" text,
	"archived" boolean DEFAULT false NOT NULL,
	"paused" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queued_agent_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"project" text NOT NULL,
	"agent_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"triggered_by" text DEFAULT 'manual' NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"enqueued_at" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" text PRIMARY KEY NOT NULL,
	"project" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text,
	"agent_id" text,
	"agent_name" text,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"payload" text,
	"created_at" double precision NOT NULL,
	"updated_at" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retrieval_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"chunk_id" text NOT NULL,
	"project" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"metadata" text NOT NULL,
	"embedding" vector(768),
	CONSTRAINT "retrieval_chunks_chunk_id_unique" UNIQUE("chunk_id")
);
--> statement-breakpoint
CREATE TABLE "retrieval_records" (
	"id" text PRIMARY KEY NOT NULL,
	"project" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"chunk_count" integer NOT NULL,
	"content_hash" text NOT NULL,
	"indexed_at" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"created_at" double precision NOT NULL,
	"updated_at" double precision NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ollama_usage_ts" ON "ollama_usage" USING btree ("ts");--> statement-breakpoint
CREATE UNIQUE INDEX "queued_agent_runs_project_agent" ON "queued_agent_runs" USING btree ("project","agent_id");