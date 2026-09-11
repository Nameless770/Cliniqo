CREATE TYPE "public"."maintenance_outcome" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "maintenance_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" "maintenance_outcome" NOT NULL,
	"rows_affected" integer DEFAULT 0 NOT NULL,
	"detail" text,
	CONSTRAINT "maintenance_run_finished_after_started" CHECK ("maintenance_run"."finished_at" is null or "maintenance_run"."finished_at" >= "maintenance_run"."started_at")
);
--> statement-breakpoint
CREATE INDEX "maintenance_run_job_idx" ON "maintenance_run" USING btree ("job","started_at" DESC NULLS LAST);--> statement-breakpoint

-- Append-only for the application role, like audit_event and for the same reason.
--
-- This table is the EVIDENCE that a documented retention window is actually enforced. A
-- record of enforcement that the enforcing process can rewrite is not evidence, and the
-- application never needs to amend a run that already happened: the runner inserts one
-- row per job per run and never revisits it.
--
-- The owner keeps full rights, so a genuine operational correction is still possible --
-- deliberately, and visibly, by someone holding the migration credential.
REVOKE UPDATE, DELETE, TRUNCATE ON "maintenance_run" FROM cliniqo_app;
