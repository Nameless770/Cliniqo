-- ---------------------------------------------------------------------------
-- 0003 — roles, permissions, and grants
--
-- Reference data, not fixtures. Application code names permissions as string literals
-- ('patient.read.clinical'), so these rows are part of the schema contract: a database
-- without them is a database where every authorization check silently denies. That makes
-- this a migration rather than a seed script — every environment gets it, including
-- production, and it is not optional.
--
-- The clinic and its first administrator ARE environment-specific, and live in
-- scripts/seed-dev.js instead.
--
-- Idempotent throughout, so re-running against a partially seeded database is safe.
-- ---------------------------------------------------------------------------

INSERT INTO "role" (code, display_name, description) VALUES
  ('admin',        'Administrator', 'Operational administration. Not a clinical role.'),
  ('doctor',       'Clinician',     'Provides care. Documents visits and prescribes.'),
  ('receptionist', 'Receptionist',  'Front desk: registration, scheduling, check-in.')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

INSERT INTO "permission" (code, description) VALUES
  -- Patient. The two read permissions are the minimum-necessary boundary
  -- (§164.502(b)): identifying data and clinical data are separately grantable, which is
  -- what lets a receptionist book an appointment without seeing a diagnosis.
  ('patient.read.identifying', 'View patient demographics and contact details'),
  ('patient.read.clinical',    'View allergies, flags, notes, and prescriptions'),
  ('patient.create',           'Register a new patient'),
  ('patient.update',           'Amend patient demographics'),
  ('patient.archive',          'Archive a patient record'),

  -- Scheduling
  ('appointment.read',    'View the schedule'),
  ('appointment.create',  'Book an appointment'),
  ('appointment.update',  'Reschedule an appointment'),
  ('appointment.cancel',  'Cancel an appointment'),
  ('appointment.checkin', 'Check a patient in'),

  -- Clinical documentation
  ('note.read',   'Read visit notes'),
  ('note.create', 'Start a visit note'),
  ('note.sign',   'Sign a visit note into the legal record'),
  ('note.amend',  'Append an addendum to a signed note'),

  -- Prescribing
  ('prescription.read',   'View prescription history'),
  ('prescription.create', 'Issue a prescription'),
  ('prescription.cancel', 'Cancel a prescription'),

  -- Administration
  ('staff.read',      'View staff accounts'),
  ('staff.create',    'Create a staff account'),
  ('staff.update',    'Amend or deactivate a staff account'),
  ('role.assign',     'Grant and revoke roles'),
  ('audit.read',      'Read the audit log'),
  ('clinic.configure','Change clinic configuration'),

  -- Emergency access. Required by §164.312(a)(2)(ii); logged loudly and reviewed.
  ('breakglass.use',  'Access a record outside normal scope, with a stated reason')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

/*
 * Grants.
 *
 * Mirrors the role matrix in CLAUDE.md. Two boundaries are load-bearing:
 *
 *   receptionist has NO clinical permission at all — not patient.read.clinical, not
 *   note.*, not prescription.*. Minimum necessary is enforced by the absence of a grant,
 *   not by a UI that hides a tab.
 *
 *   admin can READ clinical content but cannot WRITE it, and cannot prescribe. An office
 *   manager is not a clinician. Their clinical reads are audited like everyone else's,
 *   and an admin browsing charts is exactly the pattern an audit looks for.
 */
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id
FROM "role" r
JOIN "permission" p ON p.code = ANY (
  CASE r.code
    WHEN 'receptionist' THEN ARRAY[
      'patient.read.identifying',
      'patient.create',
      'patient.update',
      'appointment.read',
      'appointment.create',
      'appointment.update',
      'appointment.cancel',
      'appointment.checkin'
    ]
    WHEN 'doctor' THEN ARRAY[
      'patient.read.identifying',
      'patient.read.clinical',
      'patient.create',
      'patient.update',
      'appointment.read',
      'appointment.create',
      'appointment.update',
      'appointment.cancel',
      'appointment.checkin',
      'note.read',
      'note.create',
      'note.sign',
      'note.amend',
      'prescription.read',
      'prescription.create',
      'prescription.cancel',
      'breakglass.use'
    ]
    WHEN 'admin' THEN ARRAY[
      'patient.read.identifying',
      'patient.read.clinical',
      'patient.create',
      'patient.update',
      'patient.archive',
      'appointment.read',
      'appointment.create',
      'appointment.update',
      'appointment.cancel',
      'appointment.checkin',
      'note.read',
      'staff.read',
      'staff.create',
      'staff.update',
      'role.assign',
      'audit.read',
      'clinic.configure'
    ]
  END
)
ON CONFLICT (role_id, permission_id) DO NOTHING;
