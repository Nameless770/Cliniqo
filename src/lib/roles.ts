/**
 * Role definitions — the single source of truth.
 *
 * Isomorphic on purpose: `src/db/schema/enums.ts` builds its pg enum from ROLE_CODES, and
 * the navigation reads the same list, so the database and the UI cannot drift apart.
 *
 * This file is client-reachable, so it must stay free of server imports. It contains no
 * PHI and no secrets — only the names of roles.
 */

export const ROLE_CODES = ['admin', 'doctor', 'receptionist'] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

export const ROLE_LABELS: Record<RoleCode, string> = {
  admin: 'Administrator',
  doctor: 'Clinician',
  receptionist: 'Receptionist',
};

/**
 * Navigation entries, filtered by role.
 *
 * IMPORTANT — this is NOT access control.
 *
 * Hiding a link stops a receptionist stumbling into a page they cannot use. It stops
 * nothing else: anyone can type the URL, and a server action is a public HTTP endpoint
 * reachable regardless of what the sidebar rendered. Authorization is re-checked
 * server-side on every data operation (CLAUDE.md rule 2). Treat this list as a
 * convenience, and never as a boundary.
 */
export type NavItem = {
  href: string;
  label: string;
  roles: readonly RoleCode[];
};

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', roles: ROLE_CODES },
  { href: '/schedule', label: 'Schedule', roles: ROLE_CODES },
  { href: '/patients', label: 'Patients', roles: ROLE_CODES },
  // Clinical surfaces. Receptionists are scoped away from clinical content entirely —
  // minimum necessary, §164.502(b).
  { href: '/notes', label: 'Visit notes', roles: ['doctor', 'admin'] },
  { href: '/prescriptions', label: 'Prescriptions', roles: ['doctor'] },
  // Administration.
  { href: '/staff', label: 'Staff', roles: ['admin'] },
  { href: '/audit', label: 'Audit log', roles: ['admin'] },
  { href: '/settings', label: 'Clinic settings', roles: ['admin'] },
];

export function navItemsForRoles(roles: readonly RoleCode[]): NavItem[] {
  return NAV_ITEMS.filter((item) => item.roles.some((r) => roles.includes(r)));
}
