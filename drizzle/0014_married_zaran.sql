CREATE TABLE "patient_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"password_hash" text NOT NULL,
	"password_changed_at" timestamp with time zone,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text
);
--> statement-breakpoint
CREATE TABLE "patient_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "patient_setup_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"patient_account_id" uuid,
	"token_hash" text NOT NULL,
	"email" "citext" NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_ip" "inet",
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_event" ADD COLUMN "actor_patient_account_id" uuid;--> statement-breakpoint
ALTER TABLE "patient_account" ADD CONSTRAINT "patient_account_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_account" ADD CONSTRAINT "patient_account_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_account" ADD CONSTRAINT "patient_account_archived_by_user_account_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_session" ADD CONSTRAINT "patient_session_patient_account_id_patient_account_id_fk" FOREIGN KEY ("patient_account_id") REFERENCES "public"."patient_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_setup_token" ADD CONSTRAINT "patient_setup_token_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_setup_token" ADD CONSTRAINT "patient_setup_token_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_setup_token" ADD CONSTRAINT "patient_setup_token_patient_account_id_patient_account_id_fk" FOREIGN KEY ("patient_account_id") REFERENCES "public"."patient_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_account_email_live_idx" ON "patient_account" USING btree ("email") WHERE "patient_account"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_account_patient_live_idx" ON "patient_account" USING btree ("patient_id") WHERE "patient_account"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "patient_account_clinic_idx" ON "patient_account" USING btree ("clinic_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_session_token_idx" ON "patient_session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "patient_session_account_idx" ON "patient_session" USING btree ("patient_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_setup_token_hash_idx" ON "patient_setup_token" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_setup_token_live_idx" ON "patient_setup_token" USING btree ("patient_id") WHERE "patient_setup_token"."used_at" is null and "patient_setup_token"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_patient_account_id_patient_account_id_fk" FOREIGN KEY ("actor_patient_account_id") REFERENCES "public"."patient_account"("id") ON DELETE no action ON UPDATE no action;