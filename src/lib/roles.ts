/**
 * Role definitions — the single source of truth.
 *
 * Isomorphic on purpose: `src/db/schema/enums.ts` builds its pg enum from ROLE_CODES, and
 * the navigation reads the same list, so the database and the UI cannot drift apart.
 *
 * This file is client-reachable, so it must stay free of server imports. It contains no
 * PHI and no secrets — only the names of roles.
 */

import type { Permission } from './permissions';

export const ROLE_CODES = ['admin', 'doctor', 'receptionist'] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

export const ROLE_LABELS: Record<RoleCode, string> = {
  admin: 'Administrator',
  doctor: 'Clinician',
  receptionist: 'Receptionist',
};

/**
 * Navigation entries, keyed by the PERMISSION each destination requires.
 *
 * Keyed by permission rather than by role deliberately: the sidebar and the server guard
 * then read one matrix. A parallel role list here would be a second source of truth that
 * silently disagrees the first time somebody edits one and not the other.
 *
 * IMPORTANT — this is NOT access control.
 *
 * Hiding a link stops a receptionist stumbling into a page they cannot use. It stops
 * nothing else: anyone can type the URL, and a server action is a public HTTP endpoint
 * reachable regardless of what the sidebar rendered. The page re-checks with
 * `guardPage()`, and the fetch behind it re-checks again with `requirePermission()`.
 * Treat this list as a courtesy, never as a boundary.
 */
export type NavItem = {
  href: string;
  label: string;
  /** Undefined means available to every signed-in user. */
  requires?: Permission;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/schedule', label: 'Schedule', requires: 'appointment.read' },
  { href: '/patients', label: 'Patients', requires: 'patient.read.identifying' },
  // Clinical surfaces. Receptionists hold no clinical permission at all, so these vanish
  // for them without any role being named here - minimum necessary, 164.502(b).
  { href: '/notes', label: 'Visit notes', requires: 'note.read' },
  { href: '/prescriptions', label: 'Prescriptions', requires: 'prescription.read' },
  // Administration.
  { href: '/staff', label: 'Staff', requires: 'staff.read' },
  { href: '/audit', label: 'Audit log', requires: 'audit.read' },
  { href: '/break-glass', label: 'Emergency access', requires: 'audit.read' },
  { href: '/settings', label: 'Clinic settings', requires: 'clinic.configure' },
];

export function navItemsFor(permissions: readonly string[]): NavItem[] {
  return NAV_ITEMS.filter(
    (item) => item.requires === undefined || permissions.includes(item.requires),
  );
}
