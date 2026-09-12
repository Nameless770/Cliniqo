import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { patientAccount, patientIdentity } from '@/db/schema';
import { getEnv } from '@/env/server';
import { writeAuditEvent } from '@/server/audit/log';
import type { GoogleConfig, GoogleIdentity } from '@/server/auth/google';

import { createPatientSession } from './session';

/**
 * Google sign-in for PATIENTS.
 *
 * ==========================================================================
 * WHY THIS IS ITS OWN FILE, ITS OWN COOKIE, AND ITS OWN CALLBACK ROUTE
 * ==========================================================================
 *
 * It shares the pure OAuth machinery with the staff flow — the same PKCE, the same state
 * and nonce, the same token exchange, all in `@/server/auth/google` — and shares nothing
 * else. Different redirect URI, different handshake cookie, different resolver, different
 * session table.
 *
 * That separation is the control, not tidiness. A handshake begun on the portal cannot be
 * completed at the staff callback, because the staff callback reads a cookie this flow
 * never sets. So the interesting attack — steer a patient's Google sign-in into the staff
 * door and see whether their address also matches a staff account — has nowhere to land.
 * It is the rule `patient_account` already follows against `user_account`, applied one
 * layer up.
 *
 * ==========================================================================
 * THIS DISCLOSES SOMETHING, AND THE PATIENT IS THE ONE WHO DECIDES
 * ==========================================================================
 *
 * Redirecting a patient to Google tells Google that this identified person is signing in
 * to this clinic's application — that they are a patient there. That is health
 * information about them, going to a company that signs no Business Associate Agreement
 * for consumer sign-in, and the clinic cannot make that trade on their behalf.
 *
 * What makes it lawful is that an individual may authorize disclosures about themselves
 * (§164.508). So the flow is built so the patient is genuinely the one choosing:
 *
 *   - the clinic must enable it at all (PORTAL_GOOGLE_SIGN_IN, off by default);
 *   - the button carries a plain-language notice of exactly what Google learns, BEFORE
 *     the click that discloses it;
 *   - the authorization is recorded — when, and from which address — in
 *     `patient_identity` and in the audit log as `identity.link`;
 *   - it can be withdrawn from inside the portal, which is the part that makes it consent
 *     rather than a one-way door.
 *
 * ==========================================================================
 * IT LINKS. IT NEVER CREATES.
 * ==========================================================================
 *
 * The same rule as staff, for an additional reason. There it keeps a system holding
 * patient records from issuing itself logins. Here it also means the flow reveals nothing
 * about people who are not already patients: a Google account the clinic has never heard
 * of is refused with the same message as every other refusal, so the page cannot be asked
 * "is this person a patient here?" — which is the very fact the design exists to protect.
 */

/** Separate from the staff handshake cookie on purpose. See the header. */
export const PORTAL_OAUTH_COOKIE = 'cliniqo_portal_oauth';

/**
 * The portal's Google configuration, or null when the feature is off.
 *
 * Null is the normal case: this needs BOTH credentials and the clinic's explicit
 * PORTAL_GOOGLE_SIGN_IN. Configuring staff sign-in must never quietly switch it on for
 * patients, because those are not the same decision.
 */
export function portalGoogleConfig(): GoogleConfig | null {
  const env = getEnv();
  if (!env.PORTAL_GOOGLE_SIGN_IN) return null;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;

  // From APP_URL, never from request headers — see the staff module for why.
  const base = (env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');

  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${base}/portal/auth/google/callback`,
    /*
     * Never a hosted-domain restriction. Patients sign in with personal Google accounts,
     * which carry no `hd` claim at all, so applying the staff restriction here would
     * refuse every patient. The env validator rejects the combination outright rather
     * than leaving it to be discovered.
     */
    allowedHostedDomain: undefined,
  };
}

export type PortalGoogleResult =
  { ok: true; token: string; expiresAt: Date; linked: boolean } | { ok: false };

/**
 * Resolve a verified Google identity to a portal session.
 *
 * Returns one undifferentiated failure for every refusal — unknown account, archived,
 * suspended, locked. The caller turns that into one message. Telling them apart would
 * make the portal login page an oracle for which addresses belong to patients here.
 *
 * The caller must already have checked `state`, the nonce, and `email_verified`. An
 * unverified address must never reach this function: it is a claim in a profile, and
 * trusting it would let anyone who can type a string into a Google account sign in as the
 * patient who uses that address.
 */
export async function signInPatientWithGoogle(
  identity: GoogleIdentity,
  ip: string | null,
  userAgent: string | null,
): Promise<PortalGoogleResult> {
  const db = getDb();

  /*
   * An existing link wins over the address. `sub` is stable and an email is not: if the
   * address on a record is changed or reassigned, matching on email would hand the
   * account to whoever holds it now.
   */
  const [link] = await db
    .select({
      id: patientIdentity.id,
      patientAccountId: patientIdentity.patientAccountId,
    })
    .from(patientIdentity)
    .where(
      and(
        eq(patientIdentity.provider, 'google'),
        eq(patientIdentity.subject, identity.subject),
        isNull(patientIdentity.revokedAt),
      ),
    )
    .limit(1);

  const columns = {
    id: patientAccount.id,
    clinicId: patientAccount.clinicId,
    patientId: patientAccount.patientId,
    status: patientAccount.status,
    lockedUntil: patientAccount.lockedUntil,
  };

  const [account] = link
    ? await db
        .select(columns)
        .from(patientAccount)
        .where(
          and(
            eq(patientAccount.id, link.patientAccountId),
            isNull(patientAccount.archivedAt),
          ),
        )
        .limit(1)
    : await db
        .select(columns)
        .from(patientAccount)
        .where(
          and(
            eq(patientAccount.email, identity.email),
            isNull(patientAccount.archivedAt),
          ),
        )
        .limit(1);

  /*
   * No account: the refusal that makes this a link rather than a sign-up, and the one
   * that stops the page answering "is this person a patient here?".
   */
  if (!account) return { ok: false };

  const now = new Date();
  const locked = account.lockedUntil !== null && account.lockedUntil > now;
  if (locked || account.status !== 'active') return { ok: false };

  return db.transaction(async (tx) => {
    if (link) {
      await tx
        .update(patientIdentity)
        .set({ lastUsedAt: now })
        .where(eq(patientIdentity.id, link.id));
    } else {
      /*
       * First Google sign-in for this account. The patient has read the notice and
       * clicked through it, and Google has confirmed they control this address — so this
       * row is written as the record of that authorization, with the address it came from.
       *
       * Matching on a VERIFIED email grants nothing the address did not already grant:
       * the clinic's portal invitation is emailed to exactly this address, so whoever
       * holds it can already claim the account.
       */
      await tx.insert(patientIdentity).values({
        patientAccountId: account.id,
        provider: 'google',
        subject: identity.subject,
        emailAtLink: identity.email,
        linkedIp: ip,
        lastUsedAt: now,
      });

      await writeAuditEvent(tx, {
        clinicId: account.clinicId,
        actorPatientAccountId: account.id,
        actorIp: ip,
        actorUserAgent: userAgent,
        action: 'identity.link',
        outcome: 'allowed',
        subjectPatientId: account.patientId,
        entityType: 'patient_identity',
        entityId: account.id,
        /* Provider only. The Google subject and address live in the row, not in the log. */
        metadata: { provider: 'google', via: 'portal_login' },
      });
    }

    const created = await createPatientSession(tx, account.id, userAgent);

    await tx
      .update(patientAccount)
      .set({ lastLoginAt: now })
      .where(eq(patientAccount.id, account.id));

    await writeAuditEvent(tx, {
      clinicId: account.clinicId,
      actorPatientAccountId: account.id,
      actorIp: ip,
      actorUserAgent: userAgent,
      sessionId: created.id,
      action: 'auth.login',
      outcome: 'allowed',
      subjectPatientId: account.patientId,
      metadata: { via: 'portal_google' },
    });

    return {
      ok: true,
      token: created.token,
      expiresAt: created.absoluteExpiresAt,
      linked: !link,
    };
  });
}

export type GoogleLinkStatus = {
  connected: boolean;
  emailAtLink: string | null;
  linkedAt: Date | null;
};

/**
 * What the portal's account page shows.
 *
 * Never the provider subject. It is a stable identifier for this person at Google, and a
 * page has no use for it that a displayed email address does not serve better.
 */
export async function getGoogleLinkStatus(
  patientAccountId: string,
): Promise<GoogleLinkStatus> {
  const [row] = await getDb()
    .select({
      emailAtLink: patientIdentity.emailAtLink,
      linkedAt: patientIdentity.linkedAt,
    })
    .from(patientIdentity)
    .where(
      and(
        eq(patientIdentity.patientAccountId, patientAccountId),
        eq(patientIdentity.provider, 'google'),
        isNull(patientIdentity.revokedAt),
      ),
    )
    .limit(1);

  return row
    ? { connected: true, emailAtLink: row.emailAtLink, linkedAt: row.linkedAt }
    : { connected: false, emailAtLink: null, linkedAt: null };
}

/**
 * Withdraw the authorization.
 *
 * Marks the row revoked rather than deleting it: that consent was given and later
 * withdrawn is the part worth keeping. It does not undo the disclosure already made to
 * Google — nothing can — and the portal says so plainly instead of implying otherwise.
 *
 * The password login is untouched and is never removed, so disconnecting can never lock a
 * patient out of their own record.
 */
export async function unlinkGoogle(
  patientAccountId: string,
  clinicId: string,
  patientId: string,
  ip: string | null,
  userAgent: string | null,
): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const revoked = await tx
      .update(patientIdentity)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(patientIdentity.patientAccountId, patientAccountId),
          eq(patientIdentity.provider, 'google'),
          isNull(patientIdentity.revokedAt),
        ),
      )
      .returning({ id: patientIdentity.id });

    if (revoked.length === 0) return false;

    await writeAuditEvent(tx, {
      clinicId,
      actorPatientAccountId: patientAccountId,
      actorIp: ip,
      actorUserAgent: userAgent,
      action: 'identity.unlink',
      outcome: 'allowed',
      subjectPatientId: patientId,
      entityType: 'patient_identity',
      entityId: patientAccountId,
      metadata: { provider: 'google' },
    });

    return true;
  });
}
