-- ---------------------------------------------------------------------------
-- 0006 — appointment status vocabulary, and scheduling grants
--
-- Two changes.
--
-- 1. `booked` -> `scheduled`, to match the approved status set
--    (scheduled / checked-in / completed / no-show / cancelled).
--
--    RENAME VALUE preserves the enum member's OID, so the partial index and the GiST
--    exclusion constraint that reference this type stay valid and are NOT rebuilt. A
--    drop-and-recreate of the type would have to drop the exclusion constraint first,
--    which would leave a window where concurrent double-booking is possible. Renaming
--    avoids opening that window at all.
--
-- 2. Scheduling becomes a front-desk capability.
--
--    The approved access rules put scheduling with reception and administration, and
--    leave clinicians viewing their own schedule and moving their own appointments
--    through statuses. Today all three roles hold create/update/cancel/checkin, which is
--    broader than that. `appointment.status` is introduced for the narrow capability a
--    clinician does need, and the rest is revoked from doctor.
--
--    The row-level half — a clinician may only change the status of appointments
--    assigned to THEM — cannot be expressed as a grant and is enforced in the data-access
--    layer, which re-reads the appointment's provider before permitting the write.
-- ---------------------------------------------------------------------------

ALTER TYPE "appointment_status" RENAME VALUE 'booked' TO 'scheduled';
--> statement-breakpoint

INSERT INTO "permission" (code, description) VALUES
  ('appointment.status',
   'Move an appointment through its status lifecycle (completed, no-show). Clinicians are limited to their own appointments.')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

-- Every role may move status; scope differs and is enforced per-row.
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id
FROM "role" r
JOIN "permission" p ON p.code = 'appointment.status'
WHERE r.code IN ('admin', 'doctor', 'receptionist')
ON CONFLICT (role_id, permission_id) DO NOTHING;
--> statement-breakpoint

-- Booking, rescheduling, cancelling and check-in belong to the front desk.
DELETE FROM role_permission
WHERE role_id = (SELECT id FROM "role" WHERE code = 'doctor')
  AND permission_id IN (
    SELECT id FROM "permission"
    WHERE code IN (
      'appointment.create',
      'appointment.update',
      'appointment.cancel',
      'appointment.checkin'
    )
  );
