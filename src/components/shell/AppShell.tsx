import Link from 'next/link';

import { ToastProvider } from '@/components/ui';
import { ROLE_LABELS, type RoleCode } from '@/lib/roles';
import { logout } from '@/server/actions/auth';

import { Nav } from './Nav';
import styles from './AppShell.module.css';

/**
 * Cliniqo mark.
 *
 * A rounded square enclosing a pulse line that resolves into an upright — clinical
 * without the cliché red cross, and legible at 16px in a browser tab. Drawn inline so
 * it inherits `currentColor` and needs no network request.
 */
function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      className={styles.brandMark}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="1.5"
        y="1.5"
        width="21"
        height="21"
        rx="6.5"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M5.5 12.4h3l1.7-3.6 2.3 6.4 1.6-2.8h4.4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export type AppShellProps = {
  /** Signed-in user's display name. Staff data, not PHI. */
  userName: string;
  /** Every role the account currently holds — an account can hold more than one. */
  roles: readonly RoleCode[];
  /**
   * Permissions resolved by the server for this request.
   *
   * An array, not a Set: this crosses into a Client Component and Sets do not survive
   * serialisation. Capability names only — no PHI.
   */
  permissions: readonly string[];
  clinicName: string;
  children: React.ReactNode;
};

/**
 * Application shell: top bar, role-aware navigation, content area.
 *
 * A Server Component. `ToastProvider` is a Client Component, but `children` is passed
 * through it as a slot, so the page inside stays server-rendered — which is what keeps
 * patient data off the client boundary.
 */
export function AppShell({
  userName,
  roles,
  permissions,
  clinicName,
  children,
}: AppShellProps) {
  const roleLabel = roles.map((role) => ROLE_LABELS[role]).join(' · ');

  return (
    <ToastProvider>
      <div className={styles.shell}>
        <a href="#main" className={styles.skipLink}>
          Skip to content
        </a>

        <header className={styles.topbar}>
          <Link href="/dashboard" className={styles.brand}>
            <BrandMark />
            Cliniqo
          </Link>

          <span className={styles.clinicName}>{clinicName}</span>

          <div className={styles.topbarSpacer} />

          <div className={styles.account}>
            <span className={styles.avatar} aria-hidden="true">
              {initials(userName)}
            </span>
            <span className={styles.accountText}>
              <span>{userName}</span>
              <span className={styles.accountRole}>{roleLabel}</span>
            </span>
          </div>

          {/*
            Sign out is a FORM, not a link.
            A GET link can be triggered by any <img> tag or prefetch, which turns
            logout into a trivial denial-of-service against a working clinician. State
            changes belong behind a POST, and this one carries Next's server-action
            Origin check with it.
          */}
          <form action={logout}>
            <button type="submit" className={styles.signOut}>
              Sign out
            </button>
          </form>
        </header>

        <div className={styles.body}>
          <Nav permissions={permissions} />

          {/* tabIndex -1 so the skip link can move focus here, not just scroll. */}
          <main id="main" className={styles.main} tabIndex={-1}>
            <div className={styles.mainInner}>{children}</div>
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
