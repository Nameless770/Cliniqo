-- Patients reading their own visit notes, and the one exception.
--
-- A signed note is visible in the patient portal by default (right of access, §164.524).
-- These columns record a clinician's decision to hold back ONE note because reading it
-- online is reasonably likely to endanger the patient (§164.524(a)(3)(i)): when, by whom,
-- and why. The CHECK makes a withholding without a stated reason impossible, independent
-- of the application code. Withhold and release are also audited, so the history is kept
-- even though these columns hold only the current state.
--
-- All nullable, no defaults: metadata-only on PostgreSQL 11+, no rewrite of visit_note.
-- The CHECK is validated against existing rows, which all hold three NULLs and pass.

ALTER TABLE "visit_note" ADD COLUMN "portal_withheld_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visit_note" ADD COLUMN "portal_withheld_by" uuid;--> statement-breakpoint
ALTER TABLE "visit_note" ADD COLUMN "portal_withheld_reason" text;--> statement-breakpoint
ALTER TABLE "visit_note" ADD CONSTRAINT "visit_note_portal_withheld_by_user_account_id_fk" FOREIGN KEY ("portal_withheld_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_note" ADD CONSTRAINT "visit_note_portal_withheld_complete_chk" CHECK (("visit_note"."portal_withheld_at" is null and "visit_note"."portal_withheld_by" is null and "visit_note"."portal_withheld_reason" is null)
       or ("visit_note"."portal_withheld_at" is not null and "visit_note"."portal_withheld_by" is not null
           and length(btrim("visit_note"."portal_withheld_reason")) > 0));