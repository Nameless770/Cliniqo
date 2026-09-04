/**
 * Route group `(auth)` — unauthenticated routes.
 *
 * The parentheses mean this folder does NOT appear in the URL: /login, not /auth/login.
 * The grouping exists so that the authenticated layout can enforce a session check in
 * one place, and these routes can sit outside it without special-casing.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        padding: '2rem',
      }}
    >
      {children}
    </main>
  );
}
