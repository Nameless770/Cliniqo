-- Self-registration: staff requesting access, and patients registering online.
--
-- All columns are nullable and none has a default, so this is a metadata-only change on
-- PostgreSQL 11+ -- no table rewrite, no long lock on `patient` or `user_account`.
--
-- user_account.self_registered_at  The person created the account through "Continue with
--                                  Google". It is created with no roles, so it grants
--                                  nothing until an administrator assigns one.
-- patient.self_registered_at       A patient registered online. Always a NEW record: the
--                                  sign-up flow never attaches anyone to an existing chart.
-- patient.identity_verified_*      Staff confirmed that person's identity in person.

ALTER TABLE "user_account" ADD COLUMN "self_registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "self_registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "identity_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "identity_verified_by" uuid;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_identity_verified_by_user_account_id_fk" FOREIGN KEY ("identity_verified_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;