/**
 * Route group `(staff)` — every authenticated route lives beneath this layout.
 *
 * This is the single choke point for the session check. When auth lands, this layout
 * resolves the session and redirects to /login when there isn't one.
 *
 * IMPORTANT: this layout is NOT authorization. It answers "is someone logged in", not
 * "may this person read this record". Per CLAUDE.md, every server action re-checks
 * authorization itself and never trusts that a caller already did. A layout guard is
 * defence in depth and a UX convenience — nothing more. Treating it as the access
 * control boundary is exactly how a direct call to an unguarded action leaks a chart.
 */
export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          borderBottom: '1px solid var(--color-border)',
          padding: '0.75rem 1.25rem',
          fontWeight: 600,
        }}
      >
        Cliniqo
      </header>
      <main style={{ flex: 1, padding: '1.25rem' }}>{children}</main>
    </div>
  );
}
