-- ---------------------------------------------------------------------------
-- 0013 — permissions for the patient-rights features
--
-- `patient.export` — §164.524, right of access.
--
--   Producing a patient's complete record is a DISCLOSURE, not an ordinary read: it
--   assembles demographics, allergies, notes, prescriptions and appointments into one
--   artifact that leaves the system. It therefore gets its own permission and its own
--   audit action rather than riding on `patient.read.clinical`, so "who exported a full
--   chart" is a question the log can answer directly.
--
--   Granted to doctor and admin. NOT to receptionist — an export contains clinical
--   content, and the front desk holds no clinical permission anywhere in this system.
--
-- The accounting-of-disclosures report (§164.528) deliberately gets NO new permission.
-- It reads the audit log, so it is gated on `audit.read`, which only admin holds. The
-- person who answers "who looked at my record" should be the person who already has
-- oversight of the log, not everyone who can read the record.
--
-- Idempotent.
-- ---------------------------------------------------------------------------

INSERT INTO "permission" (code, description) VALUES
  ('patient.export',
   'Produce a patient''s complete record for disclosure to them (HIPAA right of access)')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id
FROM "role" r
JOIN "permission" p ON p.code = 'patient.export'
WHERE r.code IN ('admin', 'doctor')
ON CONFLICT (role_id, permission_id) DO NOTHING;
