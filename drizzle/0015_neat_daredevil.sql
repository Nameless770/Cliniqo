ALTER TYPE "public"."audit_entity_type" ADD VALUE 'patient_account' BEFORE 'clinic';--> statement-breakpoint
ALTER TYPE "public"."audit_entity_type" ADD VALUE 'patient_session' BEFORE 'clinic';