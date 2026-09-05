import { AppShell } from '@/components/shell/AppShell';
import type { RoleCode } from '@/lib/roles';

/**
 * Route group `(staff)` — every authenticated route lives beneath this layout.
 *
 * This is the single choke point for the session check. When auth lands in phase 2, this
 * layout resolves the session and redirects to /login when there isn't one.
 *
 * IMPORTANT: this layout is NOT authorization. It answers "is someone logged in", not
 * "may this person read this record". Per CLAUDE.md rule 2, every server action
 * re-checks authorization itself and never trusts that a caller already did. A layout
 * guard is defence in depth and a UX convenience — treating it as the access-control
 * boundary is exactly how a direct call to an unguarded action leaks a chart.
 */

// TODO(phase-2): replace with the resolved session. Hardcoded so the shell and
// styleguide are viewable before auth exists — not a fallback, and it must be deleted
// rather than defaulted when sessions land.
const DEMO_USER = {
  name: 'Nadia Rahman',
  roles: ['doctor', 'admin'] as readonly RoleCode[],
  clinic: 'Riverside Family Practice',
};

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell
      userName={DEMO_USER.name}
      roles={DEMO_USER.roles}
      clinicName={DEMO_USER.clinic}
    >
      {children}
    </AppShell>
  );
}
