import type { Metadata } from 'next';

import { clientEnv } from '@/env/client';

import './globals.css';

export const metadata: Metadata = {
  title: clientEnv.NEXT_PUBLIC_APP_NAME,
  description: 'Clinic management',

  /**
   * Search engines must never index this application. It is staff-only and every
   * authenticated page is a view onto patient data.
   */
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Root layout.
 *
 * A Server Component, and it stays one. Marking any layout `'use client'` would push
 * every page beneath it toward the client boundary — the fastest way to accidentally
 * serialise patient data into the HTML payload.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
