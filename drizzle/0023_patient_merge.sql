-- ---------------------------------------------------------------------------
-- 0022 — patient merge
--
-- Duplicate charts are a patient-safety problem: an allergy recorded on chart A is
-- invisible to a clinician reading chart B. This system produces them deliberately in two
-- places — a front-desk search that misses, and patient self-registration, which never
-- matches an existing record because nothing a sign-up form collects proves identity.
-- Both are the right call, and both are only safe if staff can reconcile afterwards.
--
-- WHAT MOVES. The child rows are repointed at the surviving chart, and `manifest` records
-- exactly which ones, so the merge can be reversed. A merge that only set
-- `patient.merged_into_patient_id` would need every query in the system to follow that
-- pointer, and the one that forgot would hide an allergy — reintroducing the failure the
-- merge exists to fix.
--
-- WHAT DOES NOT MOVE. `audit_event.subject_patient_id` stays on the duplicate: a §164.528
-- accounting for the old MRN must still answer "who read this chart". The application role
-- holds no UPDATE on `audit_event` anyway, so that is a privilege, not an intention.
-- `break_glass_grant` stays for the same reason.
--
-- No GRANT statements: migration 0001 set ALTER DEFAULT PRIVILEGES for cliniqo_app on
-- tables created by the owner, which covers this one.
-- ---------------------------------------------------------------------------

ALTER TYPE "public"."audit_entity_type" ADD VALUE 'patient_merge' BEFORE 'audit_event';--> statement-breakpoint
CREATE TABLE "patient_merge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"surviving_patient_id" uuid NOT NULL,
	"duplicate_patient_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"performed_by" uuid NOT NULL,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversal_reason" text,
	CONSTRAINT "patient_merge_distinct" CHECK ("patient_merge"."surviving_patient_id" <> "patient_merge"."duplicate_patient_id")
);
--> statement-breakpoint
ALTER TABLE "patient_merge" ADD CONSTRAINT "patient_merge_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge" ADD CONSTRAINT "patient_merge_surviving_patient_id_patient_id_fk" FOREIGN KEY ("surviving_patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge" ADD CONSTRAINT "patient_merge_duplicate_patient_id_patient_id_fk" FOREIGN KEY ("duplicate_patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge" ADD CONSTRAINT "patient_merge_performed_by_user_account_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge" ADD CONSTRAINT "patient_merge_reversed_by_user_account_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_merge_duplicate_live_idx" ON "patient_merge" USING btree ("duplicate_patient_id") WHERE "patient_merge"."reversed_at" is null;--> statement-breakpoint
CREATE INDEX "patient_merge_surviving_idx" ON "patient_merge" USING btree ("surviving_patient_id","performed_at" DESC NULLS LAST);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- No merge chains.
--
-- Enforced here rather than only in the application because the reversal path depends on
-- it. If A could be folded into B after B was folded into C, then undoing B->C would have
-- to decide what happens to A's rows, which now sit on C — and the honest answer is that
-- nobody can reconstruct the intent. Refusing the second merge keeps the structure flat,
-- so a reversal is always a straight inverse of one manifest.
--
-- The data-access layer checks the same thing first, to return a readable refusal rather
-- than a database error. This is the backstop for every other path.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cliniqo_patient_merge_no_chains()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  survivor_merged_into uuid;
  duplicate_merged_into uuid;
BEGIN
  SELECT merged_into_patient_id INTO survivor_merged_into
  FROM patient WHERE id = NEW.surviving_patient_id;

  IF survivor_merged_into IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot merge into a chart that has itself been merged away (patient %).',
      NEW.surviving_patient_id
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT merged_into_patient_id INTO duplicate_merged_into
  FROM patient WHERE id = NEW.duplicate_patient_id;

  IF duplicate_merged_into IS NOT NULL THEN
    RAISE EXCEPTION
      'Chart % has already been merged away.',
      NEW.duplicate_patient_id
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS cliniqo_patient_merge_no_chains_trg ON "patient_merge";--> statement-breakpoint
CREATE TRIGGER cliniqo_patient_merge_no_chains_trg
  BEFORE INSERT ON "patient_merge"
  FOR EACH ROW EXECUTE FUNCTION cliniqo_patient_merge_no_chains();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- `patient.merge` — administrator only.
--
-- Not folded into `patient.update`. A merge moves clinical rows between records, and a
-- wrong one combines two people's charts, which is a breach rather than an edit. Real
-- practices give that decision to health-information staff; here `admin` is the records
-- role. The front desk usually SPOTS the duplicate — they register patients and meet the
-- same person twice — and can still surface a candidate, because the candidate list reads
-- with `patient.read.identifying`. They simply cannot commit it.
--
-- Not granted to `doctor` either: a clinician correcting a chart amends it (§164.526);
-- reconciling two records is a records operation, not a clinical one.
--
-- Idempotent.
-- ---------------------------------------------------------------------------
INSERT INTO "permission" (code, description) VALUES
  ('patient.merge',
   'Fold a duplicate patient chart into the record that survives, and reverse that merge')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id
FROM "role" r
JOIN "permission" p ON p.code = 'patient.merge'
WHERE r.code = 'admin'
ON CONFLICT (role_id, permission_id) DO NOTHING;
