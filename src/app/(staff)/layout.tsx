import { headers } from 'next/headers';
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
/** The one page a user with an expired credential may still reach. */
const PASSWORD_CHANGE_PATH = '/account/password';

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const active = await getSession();

  if (!active) redirect('/login');

  /*
   * Forced password change.
   *
   * `must_change_password` was stored, selected into the session, and READ BY NOTHING —
   * a flag the setup flow sets and no code acted on. An account whose password was
   * issued or reset by another person is a shared login until that person's copy stops
   * working, and HIPAA's unique user identification rule (164.312(a)(2)(i)) is what makes
   * that unacceptable: the audit trail cannot attribute an action to one human if two can
   * sign in as them.
   *
   * Enforced here rather than in `guardPage` because three pages (dashboard, forbidden,
   * styleguide) do not call it — this layout is the only thing every staff route passes
   * through. The pathname comes from the header our middleware sets.
   */
  if (active.mustChangePassword) {
    const pathname = (await headers()).get('x-pathname') ?? '';
    if (pathname !== PASSWORD_CHANGE_PATH) redirect(PASSWORD_CHANGE_PATH);
  }

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
