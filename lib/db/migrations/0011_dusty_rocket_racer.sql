ALTER TABLE "projects" ADD COLUMN "dev_server_start_command" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "dev_server_stop_command" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "dev_server_ready_url" text;