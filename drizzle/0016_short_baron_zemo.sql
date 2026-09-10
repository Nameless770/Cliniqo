CREATE TYPE "public"."triage_message_role" AS ENUM('patient', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."triage_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."triage_urgency" AS ENUM('emergency', 'urgent', 'routine', 'self_care');--> statement-breakpoint
ALTER TYPE "public"."audit_entity_type" ADD VALUE 'triage_conversation' BEFORE 'audit_event';--> statement-breakpoint
ALTER TYPE "public"."audit_entity_type" ADD VALUE 'triage_message' BEFORE 'audit_event';--> statement-breakpoint
CREATE TABLE "triage_conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"status" "triage_status" DEFAULT 'open' NOT NULL,
	"urgency" "triage_urgency",
	"recommended_specialty" text,
	"engine" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text
);
--> statement-breakpoint
CREATE TABLE "triage_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "triage_message_role" NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "triage_message_body_present" CHECK (length(btrim("triage_message"."body")) > 0)
);
--> statement-breakpoint
ALTER TABLE "triage_conversation" ADD CONSTRAINT "triage_conversation_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_conversation" ADD CONSTRAINT "triage_conversation_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_conversation" ADD CONSTRAINT "triage_conversation_archived_by_user_account_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_message" ADD CONSTRAINT "triage_message_conversation_id_triage_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."triage_conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "triage_conversation_patient_idx" ON "triage_conversation" USING btree ("patient_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "triage_conversation_clinic_open_idx" ON "triage_conversation" USING btree ("clinic_id","created_at" DESC NULLS LAST) WHERE "triage_conversation"."status" = 'open' and "triage_conversation"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "triage_message_conversation_idx" ON "triage_message" USING btree ("conversation_id","created_at");