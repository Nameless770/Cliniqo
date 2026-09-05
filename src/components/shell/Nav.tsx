'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { navItemsFor } from '@/lib/roles';

import styles from './AppShell.module.css';

/**
 * Role-aware navigation.
 *
 * A Client Component only because the active item depends on the current pathname.
 * Nothing here is PHI — role codes, labels, and hrefs — so pushing it across the client
 * boundary costs nothing.
 *
 * THIS IS NOT ACCESS CONTROL. Filtering the list stops a receptionist wandering into a
 * page they cannot use; it stops nothing else. The URL is still typeable and every
 * server action is still a public endpoint. Authorization is re-checked server-side on
 * every data operation — CLAUDE.md rule 2.
 */
export function Nav({ permissions }: { permissions: readonly string[] }) {
  const pathname = usePathname();
  const items = navItemsFor(permissions);

  return (
    <nav className={styles.nav} aria-label="Main">
      <ul className={styles.navList}>
        {items.map((item) => {
          // Exact match, or a child route beneath it (/patients/<id>).
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={[styles.navLink, active ? styles.navLinkActive : '']
                  .filter(Boolean)
                  .join(' ')}
                /* The programmatic signal for "you are here". The styling above is the
                   visual half; this is the half assistive technology reads. */
                aria-current={active ? 'page' : undefined}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
