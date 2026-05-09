PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_projects` (
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
	`issue_auto_branch` integer DEFAULT true,
	`last_push_error` text,
	`last_push_at` real,
	`review_prompt_addendum` text,
	`fix_prompt_addendum` text
);
--> statement-breakpoint
INSERT INTO `__new_projects`("name", "path", "enabled", "github", "priority", "custom_actions", "test_command", "tests_disabled", "review_disabled", "test_cron_enabled", "test_cron_schedule", "auto_commit_enabled", "auto_push_enabled", "auto_pr_merge_enabled", "release_after_run", "issue_auto_branch", "last_push_error", "last_push_at", "review_prompt_addendum", "fix_prompt_addendum") SELECT "name", "path", "enabled", "github", "priority", "custom_actions", "test_command", "tests_disabled", "review_disabled", "test_cron_enabled", "test_cron_schedule", "auto_commit_enabled", "auto_push_enabled", "auto_pr_merge_enabled", "release_after_run", "issue_auto_branch", "last_push_error", "last_push_at", "review_prompt_addendum", "fix_prompt_addendum" FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
