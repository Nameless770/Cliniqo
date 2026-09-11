CREATE TYPE "public"."identity_provider" AS ENUM('google');--> statement-breakpoint
ALTER TYPE "public"."audit_entity_type" ADD VALUE 'user_identity' BEFORE 'audit_event';--> statement-breakpoint
CREATE TABLE "user_identity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "identity_provider" NOT NULL,
	"subject" text NOT NULL,
	"email_at_link" "citext" NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_identity" ADD CONSTRAINT "user_identity_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_identity_provider_subject_idx" ON "user_identity" USING btree ("provider","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "user_identity_user_provider_idx" ON "user_identity" USING btree ("user_id","provider");