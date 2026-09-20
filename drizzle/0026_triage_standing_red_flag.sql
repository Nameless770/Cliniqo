-- A triage conversation remembers the emergency it raised.
--
-- The engine is only ever shown the last ten turns, so an emergency raised early in a
-- long conversation used to scroll out of the window: the eleventh message would be
-- assessed as if the chest pain had never been mentioned, the patient would be told a
-- routine appointment was fine, and the denormalised `urgency` the front desk books from
-- would be overwritten with it. A red flag belongs to the conversation, not to the
-- message that happened to contain it.
--
-- Set once and never cleared. Only a clinician closing the conversation ends it.
ALTER TABLE "triage_conversation" ADD COLUMN "red_flag_code" text;--> statement-breakpoint

-- Conversations already sitting at 'emergency' were flagged by this same detector, so
-- they carry a standing flag too. Without this backfill the next message on one of them
-- would find no flag and quietly downgrade it — the exact defect this column exists to
-- prevent, reintroduced for every conversation that predates the column.
--
-- The specific code that fired was never stored, so it cannot be recovered; 'legacy'
-- records that one fired without inventing which. The message shown to the patient is
-- chosen by code, and an unrecognised code resolves to the general emergency instruction.
UPDATE "triage_conversation"
   SET "red_flag_code" = 'legacy'
 WHERE "urgency" = 'emergency'
   AND "red_flag_code" IS NULL;--> statement-breakpoint

-- No GRANT needed: privileges on this table are table-wide, so cliniqo_app reaches the
-- new column already. Stated rather than assumed, because a column the application
-- cannot write would fail closed in the worst possible place.
