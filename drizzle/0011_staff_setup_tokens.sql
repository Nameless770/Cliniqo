CREATE TABLE "staff_setup_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_ip" "inet",
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid
);
--> statement-breakpoint
ALTER TABLE "staff_setup_token" ADD CONSTRAINT "staff_setup_token_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_setup_token" ADD CONSTRAINT "staff_setup_token_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_setup_token" ADD CONSTRAINT "staff_setup_token_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_setup_token" ADD CONSTRAINT "staff_setup_token_revoked_by_user_account_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_setup_token_hash_idx" ON "staff_setup_token" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_setup_token_live_idx" ON "staff_setup_token" USING btree ("user_id") WHERE "staff_setup_token"."used_at" is null and "staff_setup_token"."revoked_at" is null;