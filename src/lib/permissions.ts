import type { RoleCode } from './roles';

/**
 * The permission catalogue and the role matrix.
 *
 * Isomorphic — no secrets, no PHI, just capability names — so the server guard and the
 * UI derive from one list rather than two that drift.
 *
 * AUTHORITY. At runtime the DATABASE is authoritative: `getSession()` reads
 * `user_role -> role_permission -> permission`, so an administrator changing a grant
 * takes effect on the next request without a deploy. This file is a typed mirror of that
 * data, used for compile-time safety (a typo becomes a type error rather than a silent
 * denial) and for UI hints.
 *
 * The two are asserted equal by `scripts/check-permissions.js`, which fails CI on drift.
 * Without that check a rename here would leave every guarded action quietly denying —
 * the worst kind of authorization bug, because it fails closed and looks like a
 * permissions misconfiguration rather than a code defect.
 */

export const PERMISSIONS = [
  /* Patient.
   * The split between identifying and clinical IS the minimum-necessary boundary
   * (§164.502(b)). It is what lets a receptionist book an appointment for someone
   * without being able to read why they are coming in. */
  'patient.read.identifying',
  'patient.read.clinical',
  'patient.create',
  'patient.update',
  /* Field-level: only a clinician may change clinical fields. `patient.update` alone
     cannot express this — a receptionist legitimately corrects a phone number. */
  'patient.update.clinical',
  'patient.archive',
  /* Right of access, §164.524. A full-record export is a disclosure, not a read. */
  'patient.export',

  /* Scheduling. */
  'appointment.read',
  'appointment.create',
  'appointment.update',
  'appointment.cancel',
  'appointment.checkin',
  /* Status lifecycle. Held by all three roles, but a clinician is limited to their OWN
     appointments — a row-level scope no grant can express, enforced in data-access. */
  'appointment.status',

  /* Clinical documentation. `note.sign` is separate from `note.create` because signing
   * is what commits a draft to the legal record — a different act from writing it. */
  'note.read',
  'note.create',
  'note.sign',
  'note.amend',

  /* Prescribing. */
  'prescription.read',
  'prescription.create',
  'prescription.cancel',

  /* Administration. */
  'staff.read',
  'staff.create',
  'staff.update',
  'role.assign',
  'audit.read',
  'clinic.configure',

  /* Emergency access — §164.312(a)(2)(ii). Granted, but every use is logged loudly and
   * lands in a review queue. */
  'breakglass.use',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * THE PERMISSION MATRIX.
 *
 * Mirrors migration 0003. Three deliberate boundaries:
 *
 *   receptionist has NO clinical permission whatsoever — not `patient.read.clinical`,
 *   not `note.*`, not `prescription.*`. Minimum necessary is enforced by the absence of
 *   a grant, never by a UI that hides a tab.
 *
 *   admin can READ clinical content but cannot WRITE it and cannot prescribe. An office
 *   manager is not a clinician. Their clinical reads are audited like everyone else's,
 *   and an administrator browsing charts is precisely the pattern an audit looks for.
 *
 *   only doctor holds `breakglass.use`, and only admin holds `audit.read`. The person
 *   who can bypass scope is not the person who reviews the bypass.
 */
export const ROLE_PERMISSIONS: Record<RoleCode, readonly Permission[]> = {
  receptionist: [
    'patient.read.identifying',
    'patient.create',
    'patient.update',
    'appointment.read',
    'appointment.create',
    'appointment.update',
    'appointment.cancel',
    'appointment.checkin',
    'appointment.status',
  ],

  doctor: [
    'patient.read.identifying',
    'patient.read.clinical',
    'patient.create',
    'patient.update',
    'patient.update.clinical',
    'patient.export',
    // Scheduling is a front-desk capability. A clinician reads the schedule and moves
    // their own appointments through statuses; they do not book, reschedule, or cancel.
    'appointment.read',
    'appointment.status',
    'note.read',
    'note.create',
    'note.sign',
    'note.amend',
    'prescription.read',
    'prescription.create',
    'prescription.cancel',
    'breakglass.use',
  ],

  admin: [
    'patient.read.identifying',
    'patient.read.clinical',
    'patient.create',
    'patient.update',
    'patient.archive',
    'patient.export',
    'appointment.read',
    'appointment.create',
    'appointment.update',
    'appointment.cancel',
    'appointment.checkin',
    'appointment.status',
    'note.read',
    // Read only. Prescribing is a licensed act; an administrator is not a clinician.
    'prescription.read',
    'staff.read',
    'staff.create',
    'staff.update',
    'role.assign',
    'audit.read',
    'clinic.configure',
  ],
};

/**
 * Does this permission set include the permission?
 *
 * Pure, and safe on the client — it operates on a set already resolved and sent by the
 * server. Use it to decide what to RENDER.
 *
 * It decides nothing about what is ALLOWED. A hidden button is a courtesy, not a
 * control: the URL is still reachable and the server action is still a public endpoint.
 * Authorization happens server-side, per operation, via `requirePermission`.
 */
export function can(
  permissions: ReadonlySet<string> | readonly string[],
  permission: Permission,
): boolean {
  return Array.isArray(permissions)
    ? permissions.includes(permission)
    : (permissions as ReadonlySet<string>).has(permission);
}

/** Permissions implied by a set of roles, per the matrix above. */
export function permissionsForRoles(roles: readonly RoleCode[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const roleCode of roles) {
    for (const p of ROLE_PERMISSIONS[roleCode] ?? []) out.add(p);
  }
  return out;
}
