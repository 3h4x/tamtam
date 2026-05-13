CREATE TABLE `ollama_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` real NOT NULL,
	`model` text NOT NULL,
	`project` text,
	`source_kind` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ollama_usage_ts` ON `ollama_usage` (`ts`);
