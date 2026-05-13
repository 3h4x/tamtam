CREATE TABLE `retrieval_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chunk_id` text NOT NULL,
	`project` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`text` text NOT NULL,
	`metadata` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `retrieval_chunks_chunk_id_unique` ON `retrieval_chunks` (`chunk_id`);--> statement-breakpoint
CREATE TABLE `retrieval_records` (
	`id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`chunk_count` integer NOT NULL,
	`content_hash` text NOT NULL,
	`indexed_at` real NOT NULL
);
