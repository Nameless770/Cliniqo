-- ---------------------------------------------------------------------------
-- HAND-EDITED after `drizzle-kit generate`.
--
-- Two additions drizzle-kit cannot express. Both are marked EDIT below.
--   1. Required extensions (citext, pg_trgm, btree_gist).
--   2. `audit_event` declared PARTITION BY RANGE — partitioning must be stated at
--      CREATE TABLE time, and cannot be added to an existing table afterwards.
--
-- Editing generated migration SQL is supported: drizzle-kit tracks migrations by
-- journal entry, not by file checksum. Re-running `generate` will not overwrite this.
-- ---------------------------------------------------------------------------

-- EDIT 1: extensions.
-- IF NOT EXISTS so this is a no-op on managed platforms where the extension is
-- pre-provisioned. Requires an elevated role — see the deployment notes: this is why
-- migrations run as the schema owner and not as the application role.
CREATE EXTENSION IF NOT EXISTS "citext";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "btree_gist";--> statement-breakpoint

CREATE TYPE "public"."allergen_type" AS ENUM('drug', 'food', 'environmental', 'other');--> statement-breakpoint
CREATE TYPE "public"."allergy_severity" AS ENUM('mild', 'moderate', 'severe', 'life_threatening');--> statement-breakpoint
CREATE TYPE "public"."appointment_status" AS ENUM('booked', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."audit_entity_type" AS ENUM('patient', 'patient_allergy', 'patient_flag', 'appointment', 'visit_note', 'visit_note_version', 'prescription', 'prescription_item', 'user_account', 'user_role', 'session', 'clinic', 'break_glass_grant');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('allowed', 'denied', 'error');--> statement-breakpoint
CREATE TYPE "public"."break_glass_review_outcome" AS ENUM('pending', 'justified', 'not_justified');--> statement-breakpoint
CREATE TYPE "public"."clinical_record_status" AS ENUM('active', 'inactive', 'entered_in_error');--> statement-breakpoint
CREATE TYPE "public"."flag_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."patient_flag_type" AS ENUM('clinical_alert', 'infection_control', 'fall_risk', 'safeguarding', 'other');--> statement-breakpoint
CREATE TYPE "public"."prescription_status" AS ENUM('draft', 'signed', 'printed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."role_code" AS ENUM('admin', 'doctor', 'receptionist');--> statement-breakpoint
CREATE TYPE "public"."schedule_exception_kind" AS ENUM('closure', 'time_off', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."session_revoked_reason" AS ENUM('logout', 'idle_timeout', 'absolute_timeout', 'role_change', 'deactivated', 'admin_revoke');--> statement-breakpoint
CREATE TYPE "public"."sex_assigned_at_birth" AS ENUM('male', 'female', 'intersex', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'deactivated');--> statement-breakpoint
CREATE TYPE "public"."visit_note_status" AS ENUM('draft', 'signed', 'amended');--> statement-breakpoint
CREATE TYPE "public"."visit_note_version_kind" AS ENUM('draft', 'signed', 'addendum');--> statement-breakpoint
CREATE TABLE "clinic" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"npi" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"phone" text,
	"mrn_prefix" text DEFAULT 'MRN' NOT NULL,
	"mrn_sequence" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clinic_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"day_of_week" smallint NOT NULL,
	"opens_at" time NOT NULL,
	"closes_at" time NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_hours_day_range" CHECK ("clinic_hours"."day_of_week" between 0 and 6),
	CONSTRAINT "clinic_hours_time_order" CHECK ("clinic_hours"."closes_at" > "clinic_hours"."opens_at")
);
--> statement-breakpoint
CREATE TABLE "auth_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid,
	"email_attempted" "citext" NOT NULL,
	"user_id" uuid,
	"ip_address" "inet",
	"succeeded" boolean NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "provider_profile" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"npi" text,
	"license_number" text,
	"license_state" text,
	"license_expires_on" date,
	"specialty" text,
	"can_prescribe" boolean DEFAULT true NOT NULL,
	"default_appointment_duration_minutes" integer DEFAULT 20 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" "role_code" NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "role_permission" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permission_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"revoked_reason" "session_revoked_reason"
);
--> statement-breakpoint
CREATE TABLE "user_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"password_hash" text NOT NULL,
	"password_changed_at" timestamp with time zone,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"full_name" text NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text
);
--> statement-breakpoint
CREATE TABLE "user_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid
);
--> statement-breakpoint
CREATE TABLE "patient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"mrn" text NOT NULL,
	"legal_first_name" text NOT NULL,
	"legal_middle_name" text,
	"legal_last_name" text NOT NULL,
	"preferred_name" text,
	"pronouns" text,
	"date_of_birth" date NOT NULL,
	"sex_assigned_at_birth" "sex_assigned_at_birth",
	"gender_identity" text,
	"phone_primary" text,
	"phone_secondary" text,
	"email" "citext",
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"preferred_language" text,
	"emergency_contact_name" text,
	"emergency_contact_phone" text,
	"emergency_contact_relationship" text,
	"deceased_date" date,
	"npp_acknowledged_at" timestamp with time zone,
	"npp_document_version" text,
	"merged_into_patient_id" uuid,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple',
        coalesce(mrn, '') || ' ' ||
        coalesce(legal_first_name, '') || ' ' ||
        coalesce(legal_middle_name, '') || ' ' ||
        coalesce(legal_last_name, '') || ' ' ||
        coalesce(preferred_name, '') || ' ' ||
        coalesce(phone_primary, '') || ' ' ||
        coalesce(phone_secondary, ''))) STORED,
	"registered_by" uuid,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text
);
--> statement-breakpoint
CREATE TABLE "patient_allergy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"allergen_type" "allergen_type" NOT NULL,
	"allergen_name" text NOT NULL,
	"allergen_code" text,
	"reaction" text,
	"severity" "allergy_severity",
	"onset_date" date,
	"status" "clinical_record_status" DEFAULT 'active' NOT NULL,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text
);
--> statement-breakpoint
CREATE TABLE "patient_flag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"flag_type" "patient_flag_type" NOT NULL,
	"label" text NOT NULL,
	"detail" text,
	"severity" "flag_severity" DEFAULT 'warning' NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text
);
--> statement-breakpoint
CREATE TABLE "appointment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"provider_user_id" uuid NOT NULL,
	"appointment_type_id" uuid NOT NULL,
	"during" "tstzrange" NOT NULL,
	"starts_at" timestamp with time zone GENERATED ALWAYS AS (lower("during")) STORED,
	"ends_at" timestamp with time zone GENERATED ALWAYS AS (upper("during")) STORED,
	"status" "appointment_status" DEFAULT 'booked' NOT NULL,
	"booking_note" text,
	"clinical_note_for_provider" text,
	"checked_in_at" timestamp with time zone,
	"checked_in_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancellation_reason" text,
	"rescheduled_from_appointment_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	CONSTRAINT "appointment_range_order" CHECK (upper("during") > lower("during"))
);
--> statement-breakpoint
CREATE TABLE "appointment_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"code" text NOT NULL,
	"display_name" text NOT NULL,
	"default_duration_minutes" integer DEFAULT 20 NOT NULL,
	"color" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"provider_user_id" uuid NOT NULL,
	"day_of_week" smallint NOT NULL,
	"starts_at" time NOT NULL,
	"ends_at" time NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_availability_day_range" CHECK ("provider_availability"."day_of_week" between 0 and 6),
	CONSTRAINT "provider_availability_time_order" CHECK ("provider_availability"."ends_at" > "provider_availability"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "schedule_exception" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"provider_user_id" uuid,
	"during" "tstzrange" NOT NULL,
	"kind" "schedule_exception_kind" NOT NULL,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visit_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"appointment_id" uuid,
	"author_user_id" uuid NOT NULL,
	"status" "visit_note_status" DEFAULT 'draft' NOT NULL,
	"current_version_id" uuid,
	"signed_at" timestamp with time zone,
	"signed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text
);
--> statement-breakpoint
CREATE TABLE "visit_note_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visit_note_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"kind" "visit_note_version_kind" DEFAULT 'draft' NOT NULL,
	"chief_complaint" text,
	"subjective" text,
	"objective" text,
	"assessment" text,
	"plan" text,
	"authored_by_user_id" uuid NOT NULL,
	"authored_at" timestamp with time zone DEFAULT now() NOT NULL,
	"frozen_at" timestamp with time zone,
	"supersedes_version_id" uuid,
	"content_hash" text
);
--> statement-breakpoint
CREATE TABLE "medication" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"generic_name" text,
	"form" text,
	"strength" text,
	"rxnorm_code" text,
	"is_controlled" boolean DEFAULT false NOT NULL,
	"dea_schedule" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prescription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"visit_note_id" uuid,
	"prescriber_user_id" uuid NOT NULL,
	"status" "prescription_status" DEFAULT 'draft' NOT NULL,
	"signed_at" timestamp with time zone,
	"printed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text
);
--> statement-breakpoint
CREATE TABLE "prescription_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prescription_id" uuid NOT NULL,
	"medication_id" uuid NOT NULL,
	"sequence" integer DEFAULT 1 NOT NULL,
	"dose" text,
	"route" text,
	"frequency" text,
	"duration_days" integer,
	"quantity" numeric,
	"quantity_unit" text,
	"refills" integer DEFAULT 0 NOT NULL,
	"instructions" text,
	"indication" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_role_codes" text[],
	"actor_ip" "inet",
	"actor_user_agent" text,
	"session_id" uuid,
	"action" text NOT NULL,
	"outcome" "audit_outcome" NOT NULL,
	"subject_patient_id" uuid,
	"entity_type" "audit_entity_type",
	"entity_id" uuid,
	"purpose" text,
	"break_glass_grant_id" uuid,
	"request_id" text,
	"metadata" jsonb,
	CONSTRAINT "audit_event_id_occurred_at_pk" PRIMARY KEY("id","occurred_at")
) PARTITION BY RANGE ("occurred_at");
--> statement-breakpoint
CREATE TABLE "break_glass_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"review_outcome" "break_glass_review_outcome" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinic_hours" ADD CONSTRAINT "clinic_hours_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_attempt" ADD CONSTRAINT "auth_attempt_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_attempt" ADD CONSTRAINT "auth_attempt_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_profile" ADD CONSTRAINT "provider_profile_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_id_permission_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_account" ADD CONSTRAINT "user_account_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_account" ADD CONSTRAINT "user_account_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_account" ADD CONSTRAINT "user_account_archived_by_user_account_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_granted_by_user_account_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_revoked_by_user_account_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_merged_into_patient_id_patient_id_fk" FOREIGN KEY ("merged_into_patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_registered_by_user_account_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_archived_by_user_account_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_recorded_by_user_account_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_archived_by_user_account_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_flag" ADD CONSTRAINT "patient_flag_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_flag" ADD CONSTRAINT "patient_flag_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_flag" ADD CONSTRAINT "patient_flag_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_flag" ADD CONSTRAINT "patient_flag_archived_by_user_account_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_provider_user_id_user_account_id_fk" FOREIGN KEY ("provider_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_appointment_type_id_appointment_type_id_fk" FOREIGN KEY ("appointment_type_id") REFERENCES "public"."appointment_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_checked_in_by_user_account_id_fk" FOREIGN KEY ("checked_in_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_cancelled_by_user_account_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_rescheduled_from_appointment_id_appointment_id_fk" FOREIGN KEY ("rescheduled_from_appointment_id") REFERENCES "public"."appointment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_archived_by_user_account_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_type" ADD CONSTRAINT "appointment_type_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_availability" ADD CONSTRAINT "provider_availability_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_availability" ADD CONSTRAINT "provider_availability_provider_user_id_user_account_id_fk" FOREIGN KEY ("provider_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_exception" ADD CONSTRAINT "schedule_exception_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_exception" ADD CONSTRAINT "schedule_exception_provider_user_id_user_account_id_fk" FOREIGN KEY ("provider_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_exception" ADD CONSTRAINT "schedule_exception_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_note" ADD CONSTRAINT "visit_note_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_note" ADD CONSTRAINT "visit_note_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_note" ADD CONSTRAINT "visit_note_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_note" ADD CONSTRAINT "visit_note_author_user_id_user_account_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_note" ADD CONSTRAINT "visit_note_current_version_id_visit_note_version_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."visit_note_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_note" ADD CONSTRAINT "visit_note_signed_by_user_account_id_fk" FOREIGN KEY ("signed_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_note" ADD CONSTRAINT "visit_note_archived_by_user_account_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_note_version" ADD CONSTRAINT "visit_note_version_visit_note_id_visit_note_id_fk" FOREIGN KEY ("visit_note_id") REFERENCES "public"."visit_note"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_note_version" ADD CONSTRAINT "visit_note_version_authored_by_user_id_user_account_id_fk" FOREIGN KEY ("authored_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_note_version" ADD CONSTRAINT "visit_note_version_supersedes_version_id_visit_note_version_id_fk" FOREIGN KEY ("supersedes_version_id") REFERENCES "public"."visit_note_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_visit_note_id_visit_note_id_fk" FOREIGN KEY ("visit_note_id") REFERENCES "public"."visit_note"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_prescriber_user_id_user_account_id_fk" FOREIGN KEY ("prescriber_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_cancelled_by_user_account_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_archived_by_user_account_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_prescription_id_prescription_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_medication_id_medication_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medication"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_user_id_user_account_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_subject_patient_id_patient_id_fk" FOREIGN KEY ("subject_patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_break_glass_grant_id_break_glass_grant_id_fk" FOREIGN KEY ("break_glass_grant_id") REFERENCES "public"."break_glass_grant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_grant" ADD CONSTRAINT "break_glass_grant_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_grant" ADD CONSTRAINT "break_glass_grant_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_grant" ADD CONSTRAINT "break_glass_grant_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_grant" ADD CONSTRAINT "break_glass_grant_revoked_by_user_account_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_grant" ADD CONSTRAINT "break_glass_grant_reviewed_by_user_account_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinic_hours_clinic_day_idx" ON "clinic_hours" USING btree ("clinic_id","day_of_week");--> statement-breakpoint
CREATE INDEX "auth_attempt_email_time_idx" ON "auth_attempt" USING btree ("email_attempted","attempted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auth_attempt_ip_time_idx" ON "auth_attempt" USING btree ("ip_address","attempted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "role_permission_permission_idx" ON "role_permission" USING btree ("permission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_hash_idx" ON "session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "session_user_live_idx" ON "session" USING btree ("user_id") WHERE "session"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "session_absolute_expiry_idx" ON "session" USING btree ("absolute_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_account_clinic_email_live_idx" ON "user_account" USING btree ("clinic_id","email") WHERE "user_account"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "user_account_clinic_status_idx" ON "user_account" USING btree ("clinic_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "user_role_live_idx" ON "user_role" USING btree ("user_id","role_id") WHERE "user_role"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "user_role_user_live_idx" ON "user_role" USING btree ("user_id") WHERE "user_role"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_clinic_mrn_idx" ON "patient" USING btree ("clinic_id","mrn");--> statement-breakpoint
CREATE INDEX "patient_search_idx" ON "patient" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "patient_last_name_trgm_idx" ON "patient" USING gin ("legal_last_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "patient_preferred_name_trgm_idx" ON "patient" USING gin ("preferred_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "patient_clinic_dob_idx" ON "patient" USING btree ("clinic_id","date_of_birth");--> statement-breakpoint
CREATE INDEX "patient_clinic_phone_idx" ON "patient" USING btree ("clinic_id","phone_primary");--> statement-breakpoint
CREATE INDEX "patient_clinic_live_idx" ON "patient" USING btree ("clinic_id") WHERE "patient"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "patient_allergy_active_idx" ON "patient_allergy" USING btree ("patient_id") WHERE "patient_allergy"."status" = 'active';--> statement-breakpoint
CREATE INDEX "patient_flag_current_idx" ON "patient_flag" USING btree ("patient_id") WHERE "patient_flag"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "appointment_patient_time_idx" ON "appointment" USING btree ("patient_id","starts_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "appointment_clinic_active_idx" ON "appointment" USING btree ("clinic_id","starts_at") WHERE "appointment"."status" in ('booked', 'checked_in', 'in_progress');--> statement-breakpoint
CREATE INDEX "appointment_provider_time_idx" ON "appointment" USING btree ("provider_user_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_type_clinic_code_idx" ON "appointment_type" USING btree ("clinic_id","code");--> statement-breakpoint
CREATE INDEX "provider_availability_provider_day_idx" ON "provider_availability" USING btree ("provider_user_id","day_of_week");--> statement-breakpoint
CREATE INDEX "schedule_exception_clinic_idx" ON "schedule_exception" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "schedule_exception_provider_idx" ON "schedule_exception" USING btree ("provider_user_id");--> statement-breakpoint
CREATE INDEX "visit_note_patient_time_idx" ON "visit_note" USING btree ("patient_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "visit_note_appointment_idx" ON "visit_note" USING btree ("appointment_id") WHERE "visit_note"."archived_at" is null and "visit_note"."appointment_id" is not null;--> statement-breakpoint
CREATE INDEX "visit_note_author_draft_idx" ON "visit_note" USING btree ("author_user_id") WHERE "visit_note"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "visit_note_version_number_idx" ON "visit_note_version" USING btree ("visit_note_id","version_number");--> statement-breakpoint
CREATE INDEX "visit_note_version_history_idx" ON "visit_note_version" USING btree ("visit_note_id","version_number" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "medication_name_trgm_idx" ON "medication" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "medication_generic_trgm_idx" ON "medication" USING gin ("generic_name" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "medication_rxnorm_idx" ON "medication" USING btree ("rxnorm_code") WHERE "medication"."rxnorm_code" is not null;--> statement-breakpoint
CREATE INDEX "prescription_patient_signed_idx" ON "prescription" USING btree ("patient_id","signed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "prescription_prescriber_draft_idx" ON "prescription" USING btree ("prescriber_user_id") WHERE "prescription"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "prescription_item_seq_idx" ON "prescription_item" USING btree ("prescription_id","sequence");--> statement-breakpoint
CREATE INDEX "audit_event_subject_time_idx" ON "audit_event" USING btree ("subject_patient_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_event_actor_time_idx" ON "audit_event" USING btree ("actor_user_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_event_entity_idx" ON "audit_event" USING btree ("entity_type","entity_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_event_clinic_time_idx" ON "audit_event" USING btree ("clinic_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_event_break_glass_idx" ON "audit_event" USING btree ("occurred_at" DESC NULLS LAST) WHERE "audit_event"."break_glass_grant_id" is not null;--> statement-breakpoint
CREATE INDEX "audit_event_denied_idx" ON "audit_event" USING btree ("occurred_at" DESC NULLS LAST) WHERE "audit_event"."outcome" = 'denied';--> statement-breakpoint
CREATE INDEX "break_glass_pending_idx" ON "break_glass_grant" USING btree ("clinic_id","granted_at" DESC NULLS LAST) WHERE "break_glass_grant"."review_outcome" = 'pending';--> statement-breakpoint
CREATE INDEX "break_glass_patient_idx" ON "break_glass_grant" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "break_glass_user_idx" ON "break_glass_grant" USING btree ("user_id");