-- ---------------------------------------------------------------------------
-- 0023 — recorded review of system activity
--
-- Security review finding F17, and M13 before it. An administrator holds
-- `patient.read.clinical` by design, so the control that makes that acceptable is somebody
-- actually reading the log. The filterable viewer has existed since phase 7; what did not
-- exist was any evidence a review ever happened.
--
-- 164.308(a)(1)(ii)(D) requires the review. 164.316(b)(1) requires it documented. A
-- safeguard whose operation leaves no trace is one the clinic cannot demonstrate on the day
-- it is asked to, so this table is the artifact rather than the analysis: a named person,
-- a named window, and what they concluded.
--
-- `findings` freezes the counts as they stood at review time. The log keeps growing and the
-- same query re-run next year returns something else, so a record naming only a period
-- could not show what was in front of the reviewer. Counts only — the detail stays in
-- `audit_event`, where it is already protected.
--
-- No GRANT statements: migration 0001 set ALTER DEFAULT PRIVILEGES for cliniqo_app on
-- tables created by the owner, which covers this one. The REVOKE below narrows it.
-- ---------------------------------------------------------------------------

ALTER TYPE "public"."audit_entity_type" ADD VALUE 'audit_review';--> statement-breakpoint
CREATE TABLE "audit_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"reviewed_by" uuid NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text NOT NULL,
	"findings" jsonb NOT NULL,
	CONSTRAINT "audit_review_period_order" CHECK ("audit_review"."period_start" < "audit_review"."period_end")
);
--> statement-breakpoint
ALTER TABLE "audit_review" ADD CONSTRAINT "audit_review_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_review" ADD CONSTRAINT "audit_review_reviewed_by_user_account_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_review_clinic_period_idx" ON "audit_review" USING btree ("clinic_id","period_start" DESC NULLS LAST);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- An attestation you can edit afterwards is not evidence.
--
-- Same reasoning as `audit_event`, applied one layer up: the application role may INSERT
-- and SELECT its own review records and nothing else. A reviewer who later disagrees with
-- themselves adds a second review of the same window — which is why the table has no
-- unique constraint on the period.
--
-- Not given the belt-and-braces trigger `audit_event` carries. That trigger exists to catch
-- the schema OWNER as well, because the audit log is the legal record with a six-year
-- retention duty. This is a smaller claim: the control that matters is that the running
-- application cannot rewrite an attestation, and this is what enforces it.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_review" FROM cliniqo_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- `audit.review` — administrator only.
--
-- Split from `audit.read` for the reason `note.sign` is split from `note.create`: reading
-- the log and putting your name to a conclusion about it are different acts, and only the
-- second is the safeguard the rule asks for. Reading the digest stays on `audit.read`,
-- following the accounting-of-disclosures precedent in 0013.
--
-- Idempotent.
-- ---------------------------------------------------------------------------
INSERT INTO "permission" (code, description) VALUES
  ('audit.review',
   'Record that a window of system activity was reviewed (HIPAA 164.308(a)(1)(ii)(D))')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id
FROM "role" r
JOIN "permission" p ON p.code = 'audit.review'
WHERE r.code = 'admin'
ON CONFLICT (role_id, permission_id) DO NOTHING;
