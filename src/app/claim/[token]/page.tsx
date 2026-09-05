import { ClaimForm } from './ClaimForm';

/**
 * Claim a staff account with a setup link.
 *
 * UNAUTHENTICATED, necessarily - the person has no account to sign into yet. It sits
 * outside the (staff) route group so the session guard does not redirect them to /login.
 *
 * The token is in the path, which means it can appear in browser history and, without
 * care, a Referer header. Two mitigations already in place: the global
 * `Referrer-Policy: no-referrer` header, and the token being single-use and short-lived
 * so a stale history entry is worthless.
 *
 * The page renders nothing about the account - not the name, not the email. An invalid
 * token and a valid one look identical until a password is submitted, so the URL cannot
 * be used to confirm that an address belongs to staff here.
 */
export const metadata = {
  title: 'Set your password - Cliniqo',
  robots: { index: false },
};
export const dynamic = 'force-dynamic';

export default async function ClaimPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        padding: '2rem',
      }}
    >
      <section style={{ maxWidth: '24rem', width: '100%' }}>
        <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-1)' }}>
          Set your password
        </h1>
        <p
          style={{
            margin: '0 0 var(--space-5)',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          Choose a password only you know. Nobody at the clinic can see it, including the
          administrator who created your account.
        </p>

        <ClaimForm token={token} />
      </section>
    </main>
  );
}
