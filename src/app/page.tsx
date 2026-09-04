import { redirect } from 'next/navigation';

/**
 * There is no public landing page. Cliniqo is staff-only, so the root sends visitors
 * straight to the sign-in route.
 *
 * Once auth exists (phase 2), this becomes a session check: authenticated staff go to
 * their role's home, everyone else to /login.
 */
export default function RootPage() {
  redirect('/login');
}
