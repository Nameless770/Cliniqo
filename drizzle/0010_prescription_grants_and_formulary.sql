-- ---------------------------------------------------------------------------
-- 0010 — prescription read access for administrators, and a starter formulary
--
-- 1. `prescription.read` for admin.
--
--    The approved access rule is "only doctor can create; doctor and admin can view".
--    Admin held no prescription permission at all, so this grants the read half only —
--    matching the note boundary, where an administrator can see clinical content but
--    cannot author it. Prescribing is a licensed act; an office manager issuing one is
--    not a permissions question, it is a criminal one.
--
-- 2. A starter formulary.
--
--    Reference data, like roles and permissions: the prescribing UI cannot function
--    without it, so it ships to every environment rather than living in a dev seed.
--    Deliberately includes ONE controlled substance so the block in migration 0001 is
--    demonstrable rather than theoretical — Cliniqo does not implement DEA EPCS, and the
--    database refuses to prescribe it.
-- ---------------------------------------------------------------------------

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id
FROM "role" r
JOIN "permission" p ON p.code = 'prescription.read'
WHERE r.code = 'admin'
ON CONFLICT (role_id, permission_id) DO NOTHING;
--> statement-breakpoint

INSERT INTO medication (name, generic_name, form, strength, is_controlled, dea_schedule) VALUES
  ('Amoxicillin 500mg',        'amoxicillin',            'capsule', '500 mg',    false, NULL),
  ('Amoxicillin 250mg/5ml',    'amoxicillin',            'solution','250 mg/5ml',false, NULL),
  ('Lisinopril 10mg',          'lisinopril',             'tablet',  '10 mg',     false, NULL),
  ('Metformin 500mg',          'metformin',              'tablet',  '500 mg',    false, NULL),
  ('Atorvastatin 20mg',        'atorvastatin',           'tablet',  '20 mg',     false, NULL),
  ('Levothyroxine 50mcg',      'levothyroxine',          'tablet',  '50 mcg',    false, NULL),
  ('Sertraline 50mg',          'sertraline',             'tablet',  '50 mg',     false, NULL),
  ('Salbutamol inhaler',       'salbutamol',             'inhaler', '100 mcg',   false, NULL),
  ('Prednisolone 5mg',         'prednisolone',           'tablet',  '5 mg',      false, NULL),
  ('Ibuprofen 400mg',          'ibuprofen',              'tablet',  '400 mg',    false, NULL),
  ('Omeprazole 20mg',          'omeprazole',             'capsule', '20 mg',     false, NULL),
  ('Amlodipine 5mg',           'amlodipine',             'tablet',  '5 mg',      false, NULL),
  -- Out of scope, and enforced as such. Present so the guard can be demonstrated.
  ('Oxycodone 5mg',            'oxycodone',              'tablet',  '5 mg',      true,  'CII')
ON CONFLICT DO NOTHING;
