-- Patient Google sign-in: the link table, and the audit entity type that names it.
--
-- `patient_identity` deliberately mirrors `user_identity` instead of reusing it. The staff
-- resolver joins only to `user_account` and this one joins only to `patient_account`, so
-- no query can cross from a patient identity into a staff session. Same rule
-- `patient_account` already follows, one layer up.
--
-- Both unique indexes are PARTIAL on `revoked_at is null`. Withdrawing consent revokes the
-- row rather than deleting it -- the record that authorization was given and later taken
-- back is the part worth keeping -- so a full unique index would make re-connecting later
-- collide with the tombstone of the first link.
--
-- No GRANT statements: migration 0001 set ALTER DEFAULT PRIVILEGES for cliniqo_app on
-- tables created by the owner, which covers this one.

ALTER TYPE "public"."audit_entity_type" ADD VALUE 'patient_identity' BEFORE 'audit_event';--> statement-breakpoint
CREATE TABLE "patient_identity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_account_id" uuid NOT NULL,
	"provider" "identity_provider" NOT NULL,
	"subject" text NOT NULL,
	"email_at_link" "citext" NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"linked_ip" "inet",
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "patient_identity" ADD CONSTRAINT "patient_identity_patient_account_id_patient_account_id_fk" FOREIGN KEY ("patient_account_id") REFERENCES "public"."patient_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_identity_provider_subject_live_idx" ON "patient_identity" USING btree ("provider","subject") WHERE "patient_identity"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_identity_account_provider_live_idx" ON "patient_identity" USING btree ("patient_account_id","provider") WHERE "patient_identity"."revoked_at" is null;