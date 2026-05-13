CREATE TABLE IF NOT EXISTS `maintenance_status` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` real NOT NULL
);
