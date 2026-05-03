CREATE TABLE `recommendations` (
	`id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text,
	`agent_id` text,
	`agent_name` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`payload` text,
	`created_at` real NOT NULL,
	`updated_at` real NOT NULL
);
--> statement-breakpoint
ALTER TABLE `jobs` ADD `work_summary` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `modified_files` text;