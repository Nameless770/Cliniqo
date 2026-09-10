import type { Metadata } from 'next';
import Link from 'next/link';

import { clientEnv } from '@/env/client';

import styles from './home.module.css';

const appName = clientEnv.NEXT_PUBLIC_APP_NAME;

export const metadata: Metadata = {
  title: `${appName} — clinic appointments`,
  description: 'Book, move or cancel your clinic appointments online.',
};

/**
 * The public front door.
 *
 * WHY IT READS NOTHING. This page touches no session and no database, which makes it
 * fully static — and that is the point rather than an optimisation. Three consequences,
 * in order of how much they matter:
 *
 *   1. There is nothing here to leak. An unauthenticated page that resolves a session is
 *      an unauthenticated page that can get the answer wrong, and the failure mode is
 *      showing one visitor something about another.
 *   2. It still renders when PostgreSQL is down. That is precisely the moment a patient
 *      needs to be told to phone the clinic, and a landing page that dies with the
 *      database tells them nothing at all.
 *   3. No query runs for anonymous traffic, which is most traffic a front door sees.
 *
 * The cost is that a signed-in visitor is not greeted by name and sees the same two doors
 * as everyone else. That costs them one click: `/login` and `/portal/login` both redirect
 * an existing session onward, so nobody is asked to sign in twice.
 *
 * WHY IT NAMES NO CLINIC. Multi-tenancy is still undecided, and nothing in the app maps
 * an anonymous request to a clinic — there is no host, subdomain, or path rule. Printing
 * the clinic's name, hours and phone number would mean inventing that rule here, in the
 * one place it is hardest to change later. So the page is product-level, and the clinic's
 * own details wait for that decision.
 *
 * `robots: noindex` is inherited from the root layout and deliberately not overridden.
 */
export default function HomePage() {
  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <span className={styles.wordmark}>{appName}</span>
        <Link href="/login" className={styles.barLink}>
          Staff sign in
        </Link>
      </header>

      <main className={styles.main}>
        <div className={styles.hero}>
          <div className={styles.rule} aria-hidden="true" />
          <h1 className={styles.title}>Your clinic appointments, online.</h1>
          <p className={styles.lede}>
            See what you have booked, choose a new time from what is actually free, and
            change your mind without waiting on hold.
          </p>
        </div>

        <div className={styles.doors}>
          {/*
            A link whose content is a heading plus two paragraphs takes its accessible
            name from all of it, so a screen reader announces the entire card as the link
            text. The label states the destination in a few words instead.
          */}
          <Link
            href="/portal/login"
            aria-label="I'm a patient — go to the patient portal"
            className={`${styles.door} ${styles.doorPrimary}`}
          >
            <h2 className={styles.doorTitle}>I&rsquo;m a patient</h2>
            <p className={styles.doorBody}>
              View your upcoming and past appointments, book a new one, or reschedule and
              cancel what you already have.
            </p>
            <p className={styles.doorCta}>Go to the patient portal →</p>
            <p className={styles.doorNote}>
              Your clinic creates your account and sends you a link to set a password.
              There is no public sign-up.
            </p>
          </Link>

          <Link
            href="/login"
            aria-label="I work at the clinic — staff sign in"
            className={styles.door}
          >
            <h2 className={styles.doorTitle}>I work at the clinic</h2>
            <p className={styles.doorBody}>
              The day&rsquo;s schedule, patient records, visit notes and prescriptions —
              whatever your role is allowed to see.
            </p>
            <p className={styles.doorCta}>Staff sign in →</p>
            <p className={styles.doorNote}>
              Accounts are issued by an administrator, one per person. No shared logins.
            </p>
          </Link>
        </div>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Booking, in three steps</h2>
          <ol className={styles.steps}>
            <li className={styles.step}>
              <h3 className={styles.stepTitle}>Say what the visit is for</h3>
              <p className={styles.stepBody}>
                The visit type decides how long the appointment needs to be, so it comes
                first.
              </p>
            </li>
            <li className={styles.step}>
              <h3 className={styles.stepTitle}>Pick a time that is free</h3>
              <p className={styles.stepBody}>
                Every clinician&rsquo;s genuinely open slots, in the clinic&rsquo;s own
                time. Nothing offered is already taken.
              </p>
            </li>
            <li className={styles.step}>
              <h3 className={styles.stepTitle}>Change it if you need to</h3>
              <p className={styles.stepBody}>
                Move or cancel any upcoming appointment yourself, up until it starts.
              </p>
            </li>
          </ol>
        </section>

        {/*
          On the front door of anything medical, and not negotiable. Someone in trouble
          should not be reading about appointment types.
        */}
        <aside className={styles.emergency} role="note">
          <p className={styles.emergencyTitle}>If this is an emergency, do not use this site.</p>
          <p className={styles.emergencyBody}>
            Call your local emergency number or go to your nearest emergency department.
            Nobody monitors this site for urgent messages.
          </p>
        </aside>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <p>
            {appName} handles medical information. You can only reach your own records, and
            every access is recorded.
          </p>
          <p>
            <Link href="/portal/login" className={styles.barLink}>
              Patient sign in
            </Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
