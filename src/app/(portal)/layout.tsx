/**
 * Patient portal layout.
 *
 * Deliberately NOT the staff AppShell. Patients get a plain, calm, single-column surface
 * with none of the clinical navigation — they can see and book their own appointments and
 * nothing else. Authentication is enforced per page (the dashboard redirects to the login
 * when there is no portal session); login and claim are intentionally public.
 */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100dvh',
        background: 'var(--bg-page)',
        color: 'var(--text-primary)',
      }}
    >
      <main
        style={{
          maxWidth: '44rem',
          margin: '0 auto',
          padding: 'var(--space-8) var(--space-4) var(--space-16)',
        }}
      >
        {children}
      </main>
    </div>
  );
}
