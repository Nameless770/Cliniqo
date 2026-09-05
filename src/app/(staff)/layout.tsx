import { redirect } from 'next/navigation';

import { AppShell } from '@/components/shell/AppShell';
import { getSession } from '@/server/auth/session';

/**
 * Route group `(staff)` — every authenticated route lives beneath this layout.
 *
 * The single choke point for the SESSION check: no session, no page.
 *
 * IMPORTANT: this is authentication, not authorization. It answers "is someone signed
 * in", never "may this person read this record". Per CLAUDE.md rule 2 every server action
 * re-checks its own authorization and trusts no caller — a layout guard is defence in
 * depth and a redirect convenience. Treating it as the access-control boundary is exactly
 * how a direct call to an unguarded action leaks a chart.
 */
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const active = await getSession();

  if (!active) redirect('/login');

  return (
    <AppShell
      userName={active.fullName}
      roles={active.roles}
      permissions={[...active.permissions]}
      clinicName={active.clinicName}
    >
      {children}
    </AppShell>
  );
}
