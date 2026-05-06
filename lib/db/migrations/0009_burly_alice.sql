CREATE TABLE `queued_agent_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_name` text NOT NULL,
	`triggered_by` text DEFAULT 'manual' NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`enqueued_at` real NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `queued_agent_runs_project_agent` ON `queued_agent_runs` (`project`,`agent_id`);