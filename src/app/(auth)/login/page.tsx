/**
 * Placeholder. Authentication is phase 2 — see docs/01-requirements-analysis.md §6.
 *
 * When implemented, this page renders a Server Component form posting to a server action
 * in src/server/actions/auth. Credentials are never handled in a Client Component.
 */
export default function LoginPage() {
  return (
    <section style={{ maxWidth: '22rem', width: '100%' }}>
      <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.5rem' }}>Cliniqo</h1>
      <p style={{ color: 'var(--color-muted)', margin: 0 }}>
        Sign-in is not implemented yet. Authentication and session management land in
        phase 2, alongside the authorization primitive and the audit log.
      </p>
    </section>
  );
}
