PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`project` text NOT NULL,
	`skill_ids` text DEFAULT '[]' NOT NULL,
	`model` text DEFAULT 'normal' NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`schedule` text,
	`runner` text DEFAULT 'pm2' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`doc_paths` text DEFAULT '[]' NOT NULL,
	`created_at` real NOT NULL,
	`updated_at` real NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_agents`("id", "name", "project", "skill_ids", "model", "prompt", "schedule", "runner", "enabled", "doc_paths", "created_at", "updated_at") SELECT "id", "name", "project", "skill_ids", "model", "prompt", "schedule", "runner", "enabled", "doc_paths", "created_at", "updated_at" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;