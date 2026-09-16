-- ---------------------------------------------------------------------------
-- 0024 — TOTP second factor for staff accounts
--
-- Every other control in this system assumes the account is the person. Rate limiting, the
-- PHI read budget, the audit trail and the whole permission matrix are written in terms of
-- an authenticated actor, so a stolen password is not one compromised control but all of
-- them at once — with every action correctly attributed to somebody who did not perform it.
-- A second factor is the only thing in that list which survives the password.
--
-- THE SECRET IS ENCRYPTED, NOT HASHED. It has to be read back to compute the expected code.
-- AES-256-GCM, keyed from SESSION_SECRET by a purpose-scoped derivation (see
-- src/server/auth/totp.ts). Rotating SESSION_SECRET therefore makes every enrollment
-- undecryptable and everyone re-enrolls — recorded there, and the first thing to revisit
-- if key rotation becomes routine.
--
-- `last_used_step` is what makes this a second FACTOR rather than a second field: a code is
-- valid for a thirty-second window, so without spending the counter anyone who watches it
-- being typed can replay it.
--
-- Recovery codes are hashed and single-use. Their absence is not a smaller feature, it is a
-- different one: the recovery path becomes "ring an administrator", who in a small clinic
-- is often the locked-out person, and an urgent lockout is the pressure that gets 2FA
-- switched off for everybody.
--
-- No GRANT statements: migration 0001 set ALTER DEFAULT PRIVILEGES for cliniqo_app on
-- tables created by the owner, which covers both of these.
-- ---------------------------------------------------------------------------

ALTER TYPE "public"."audit_entity_type" ADD VALUE 'user_totp' BEFORE 'patient_merge';--> statement-breakpoint
CREATE TABLE "user_recovery_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	"used_ip" "inet"
);
--> statement-breakpoint
CREATE TABLE "user_totp" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"secret_sealed" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_used_step" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_by" uuid
);
--> statement-breakpoint
ALTER TABLE "user_recovery_code" ADD CONSTRAINT "user_recovery_code_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_totp" ADD CONSTRAINT "user_totp_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_totp" ADD CONSTRAINT "user_totp_disabled_by_user_account_id_fk" FOREIGN KEY ("disabled_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_recovery_code_live_idx" ON "user_recovery_code" USING btree ("user_id") WHERE "user_recovery_code"."used_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_recovery_code_hash_idx" ON "user_recovery_code" USING btree ("code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "user_totp_user_live_idx" ON "user_totp" USING btree ("user_id") WHERE "user_totp"."disabled_at" is null;