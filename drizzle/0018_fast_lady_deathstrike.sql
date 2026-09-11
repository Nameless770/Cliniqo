CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'issued', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'card', 'bank_transfer', 'insurance', 'other');--> statement-breakpoint
ALTER TYPE "public"."audit_entity_type" ADD VALUE 'invoice' BEFORE 'audit_event';--> statement-breakpoint
ALTER TYPE "public"."audit_entity_type" ADD VALUE 'invoice_line' BEFORE 'audit_event';--> statement-breakpoint
ALTER TYPE "public"."audit_entity_type" ADD VALUE 'payment' BEFORE 'audit_event';--> statement-breakpoint
CREATE TABLE "invoice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"number" bigserial NOT NULL,
	"appointment_id" uuid,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"currency" text NOT NULL,
	"issued_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"memo" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	CONSTRAINT "invoice_void_has_reason" CHECK (("invoice"."status" <> 'void') or ("invoice"."voided_at" is not null and "invoice"."void_reason" is not null)),
	CONSTRAINT "invoice_currency_iso" CHECK ("invoice"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "invoice_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"code" text,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_amount_cents" integer NOT NULL,
	"amount_cents" integer GENERATED ALWAYS AS ("quantity" * "unit_amount_cents") STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_line_quantity_positive" CHECK ("invoice_line"."quantity" > 0),
	CONSTRAINT "invoice_line_amount_non_negative" CHECK ("invoice_line"."unit_amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_amount_positive" CHECK ("payment"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "clinic" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_voided_by_user_account_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_archived_by_user_account_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_recorded_by_user_account_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_clinic_number_idx" ON "invoice" USING btree ("clinic_id","number");--> statement-breakpoint
CREATE INDEX "invoice_patient_idx" ON "invoice" USING btree ("patient_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "invoice_clinic_outstanding_idx" ON "invoice" USING btree ("clinic_id","due_at") WHERE "invoice"."status" = 'issued' and "invoice"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "invoice_line_invoice_idx" ON "invoice_line" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payment_invoice_idx" ON "payment" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payment_clinic_time_idx" ON "payment" USING btree ("clinic_id","received_at" DESC NULLS LAST);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Billing permissions.
--
-- The role matrix in CLAUDE.md has granted billing to admin and receptionist since the
-- beginning; nothing implemented it. These are the grants that make the matrix true.
--
-- `doctor` is deliberately absent. A clinician does not need to know what a patient owes
-- in order to treat them, and knowing it is the kind of thing that quietly shapes care.
--
-- `billing.void` is admin-only: reversing a document already sent to somebody is the one
-- billing act that should require a second kind of authority.
--
-- Idempotent.
-- ---------------------------------------------------------------------------

INSERT INTO "permission" (code, description) VALUES
  ('billing.read',   'View invoices, line items and payments'),
  ('billing.create', 'Create and issue invoices, and add line items to a draft'),
  ('billing.void',   'Void an issued invoice, with a recorded reason'),
  ('payment.record', 'Record a payment against an invoice')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id
FROM "role" r
JOIN "permission" p ON p.code IN ('billing.read', 'billing.create', 'payment.record')
WHERE r.code IN ('admin', 'receptionist')
ON CONFLICT (role_id, permission_id) DO NOTHING;
--> statement-breakpoint

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id
FROM "role" r
JOIN "permission" p ON p.code = 'billing.void'
WHERE r.code = 'admin'
ON CONFLICT (role_id, permission_id) DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- An issued invoice's lines are frozen.
--
-- The same guarantee as prescription items and signed note versions, for the same reason:
-- once a document has been given to somebody, editing it in place rewrites history. A
-- wrong invoice is corrected by voiding it — which records who, when and why — and issuing
-- a replacement.
--
-- Enforced by a trigger rather than in application code because the application is not the
-- only thing that can reach this table, and "we only ever update drafts" is a convention
-- until the database makes it a rule.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cliniqo_invoice_line_frozen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT i.status::text INTO parent_status
  FROM invoice i
  WHERE i.id = COALESCE(NEW.invoice_id, OLD.invoice_id);

  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION
      'Invoice is % and its lines cannot be changed. Void it and issue a replacement.',
      parent_status
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "invoice_line_frozen_guard"
  BEFORE UPDATE OR DELETE ON "invoice_line"
  FOR EACH ROW EXECUTE FUNCTION cliniqo_invoice_line_frozen();
--> statement-breakpoint

-- Inserting a line into an already-issued invoice is the same violation from the other
-- direction, and the BEFORE UPDATE/DELETE trigger above cannot see it.
CREATE TRIGGER "invoice_line_insert_guard"
  BEFORE INSERT ON "invoice_line"
  FOR EACH ROW EXECUTE FUNCTION cliniqo_invoice_line_frozen();
