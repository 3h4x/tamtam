CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`project` text NOT NULL,
	`skill_ids` text DEFAULT '[]' NOT NULL,
	`model` text DEFAULT 'sonnet' NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`schedule` text,
	`runner` text DEFAULT 'pm2' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` real NOT NULL,
	`updated_at` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gh_issues_cache` (
	`project` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`prs` text DEFAULT '[]' NOT NULL,
	`issues` text DEFAULT '[]' NOT NULL,
	`fetched_at` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gh_status` (
	`project` text PRIMARY KEY NOT NULL,
	`release_tag` text,
	`ci` text,
	`ci_failed_url` text,
	`head_sha` text,
	`local_head_sha` text,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`kind` text NOT NULL,
	`prompt` text,
	`pid` integer NOT NULL,
	`log_path` text,
	`started_at` real NOT NULL,
	`finished_at` real,
	`exit_code` integer,
	`seen` integer DEFAULT false,
	`duration_ms` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`cache_create_tokens` integer,
	`session_id` text,
	`user_prompt` text,
	`context_meta` text,
	`parent_job_id` text,
	`gh_issue_number` integer,
	`gh_issue_repo` text,
	`gh_issue_title` text,
	`log_pruned` integer DEFAULT false,
	`cost_usd` real,
	`model` text,
	`release_id` text
);
--> statement-breakpoint
CREATE TABLE `pipeline_locks` (
	`project` text PRIMARY KEY NOT NULL,
	`locked_by_job_id` text NOT NULL,
	`acquired_at` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`name` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`enabled` integer DEFAULT false,
	`github` text,
	`priority` text,
	`custom_actions` text,
	`test_command` text,
	`tests_disabled` integer DEFAULT false,
	`review_disabled` integer DEFAULT false,
	`test_cron_enabled` integer DEFAULT false,
	`test_cron_schedule` text,
	`auto_commit_enabled` integer DEFAULT false,
	`auto_push_enabled` integer DEFAULT false,
	`auto_pr_merge_enabled` integer DEFAULT false,
	`release_after_run` integer DEFAULT false,
	`pr_workflow_enabled` integer DEFAULT false,
	`issue_auto_branch` integer DEFAULT true,
	`last_push_error` text,
	`last_push_at` real
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`created_at` real NOT NULL,
	`updated_at` real NOT NULL
);
