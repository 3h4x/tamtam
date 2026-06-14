ALTER TABLE "agents" ADD COLUMN "role" text DEFAULT 'producer' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "autopilot_state" text;
