CREATE TABLE "gh_issue_detail_cache" (
	"id" serial PRIMARY KEY NOT NULL,
	"project" text NOT NULL,
	"number" integer NOT NULL,
	"payload" text NOT NULL,
	"fetched_at" double precision NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "gh_issue_detail_cache_project_number" ON "gh_issue_detail_cache" USING btree ("project","number");