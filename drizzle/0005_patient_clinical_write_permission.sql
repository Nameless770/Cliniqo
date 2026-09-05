-- ---------------------------------------------------------------------------
-- 0005 — `patient.update.clinical`
--
-- The matrix had `patient.update`, which both a receptionist and a clinician hold: both
-- legitimately correct a phone number. It could not express the thing that actually
-- matters — that only a clinician may change a patient's clinical fields.
--
-- Without this permission the field-level boundary would have to be inferred from
-- `patient.read.clinical`, conflating "may see" with "may change". They are different
-- questions, and an administrator is the case that proves it: admin CAN read clinical
-- content (audited, and justified) but must never edit it, because an office manager is
-- not a clinician. Granted to doctor only.
--
-- Idempotent.
-- ---------------------------------------------------------------------------

INSERT INTO "permission" (code, description) VALUES
  ('patient.update.clinical',
   'Change clinical fields on a patient record: allergies, medical flags, sex assigned at birth, deceased date')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id
FROM "role" r
JOIN "permission" p ON p.code = 'patient.update.clinical'
WHERE r.code = 'doctor'
ON CONFLICT (role_id, permission_id) DO NOTHING;
