ALTER TABLE "projects" ADD COLUMN "post_merge_watch_minutes" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "auto_revert_enabled" boolean DEFAULT false;