CREATE TABLE `notification_throttle` (
	`key` text PRIMARY KEY NOT NULL,
	`last_sent_at` integer NOT NULL,
	`suppressed_count` integer DEFAULT 0 NOT NULL
);
