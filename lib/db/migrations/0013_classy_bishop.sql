ALTER TABLE "agents" ADD COLUMN "kind" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "retrieval_records" ADD COLUMN "embedding_model" text;