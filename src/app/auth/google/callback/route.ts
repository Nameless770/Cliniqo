import { and, eq, isNull } from 'drizzle-orm';
import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import { role, userAccount, userIdentity, userRole } from '@/db/schema';
import { writeAuditEvent } from '@/server/audit/log';
import { recordAttempt } from '@/server/auth/rate-limit';
import {
  OAUTH_COOKIE,
  exchangeCode,
  googleConfig,
  statesMatch,
  type GoogleIdentity,
  type OAuthHandshake,
} from '@/server/auth/google';
import {
  createSession,
  requestMeta,
  safeInet,
  sessionCookieName,
  sessionCookieOptions,
} from '@/server/auth/session';

/**
 * Leg two: Google sends the browser back.
 *
 * ==========================================================================
 * THIS LINKS. IT NEVER CREATES.
 * ==========================================================================
 *
 * A successful Google sign-in proves who is at the keyboard. It does not decide who may
 * have an account — an administrator does, deliberately, one per identified human
 * (§164.312(a)(2)(i)). So the flow ends in a refusal unless a matching staff account
 * already exists and is active. Without that rule, anyone with a Google address could mint
 * themselves a staff login on a system holding patient records.
 *
 * ONE GENERIC FAILURE for every rejection. A bad state, a stale handshake, an unverified
 * address, the wrong Workspace domain, an unknown account, a disabled one — all return the
 * same message. Distinguishing them would turn the sign-in page into an oracle for which
 * addresses belong to clinic staff.
 *
 * Refusals are still audited where an account is identifiable, and always recorded as an
 * authentication attempt, so a campaign against the SSO door looks the same in the log as
 * one against the password door.
 */
export const dynamic = 'force-dynamic';

const FAILURE = '/login?error=sso';
/* An infrastructure failure, not a refusal. See the try/catch below for why the two
   are allowed to be distinguishable when no other refusal is. */
const UNAVAILABLE = '/login?error=unavailable';

function parseHandshake(raw: string | undefined): OAuthHandshake | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const h = parsed as Record<string, unknown>;
    return typeof h['state'] === 'string' &&
      typeof h['nonce'] === 'string' &&
      typeof h['codeVerifier'] === 'string'
      ? { state: h['state'], nonce: h['nonce'], codeVerifier: h['codeVerifier'] }
      : null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const config = googleConfig();
  if (!config) return NextResponse.redirect(new URL('/login', request.url), 303);

  const base = config.redirectUri;

  const response = (target: string) => {
    const res = NextResponse.redirect(new URL(target, base), 303);
    // The handshake is single-use whatever the outcome; clearing it prevents replay.
    res.cookies.set(OAUTH_COOKIE, '', { ...sessionCookieOptions(), maxAge: 0 });
    return res;
  };

  const handshake = parseHandshake(request.cookies.get(OAUTH_COOKIE)?.value);
  const returnedState = request.nextUrl.searchParams.get('state');
  const code = request.nextUrl.searchParams.get('code');

  /* The CSRF check. Without it, an attacker can complete a flow of their own choosing in
     the victim's browser and land them in the attacker's account. */
  if (!handshake || !returnedState || !statesMatch(handshake.state, returnedState)) {
    return response(FAILURE);
  }
  if (!code) return response(FAILURE);

  let identity: GoogleIdentity | null = null;
  try {
    identity = await exchangeCode(config, code, handshake.codeVerifier);
  } catch {
    identity = null;
  }
  if (!identity) return response(FAILURE);

  /* The nonce binds this ID token to the handshake we started, so a token minted for a
     different request cannot be replayed into this one. */
  if (identity.nonce !== handshake.nonce) return response(FAILURE);

  /* An unverified address is a claim, not a fact — anyone can put a string in a profile. */
  if (!identity.emailVerified) return response(FAILURE);

  /* The `hd` claim, checked server-side. The `hd` parameter on the way out is only a hint
     to Google's chooser and is not a control. */
  if (
    config.allowedHostedDomain &&
    identity.hostedDomain !== config.allowedHostedDomain
  ) {
    return response(FAILURE);
  }

  /*
   * ==========================================================================
   * EVERYTHING BELOW TOUCHES THE DATABASE
   * ==========================================================================
   *
   * Resolving the account, opening the session and writing the audit row all require
   * PostgreSQL. When it is unreachable, every one of them throws.
   *
   * A throw here would skip the `response()` helper entirely, so the handshake cookie
   * would survive the failed attempt -- and the comment in that helper promises it is
   * single-use WHATEVER the outcome. Catching is what keeps that true.
   *
   * A separate outcome from FAILURE, and safe to distinguish: the generic-refusal rule
   * exists so this page cannot be asked which addresses hold accounts, and an outage
   * answers identically for every address, so it reveals nothing about any of them.
   * Telling somebody "try again" when the truth is "our database is down" would just
   * send them to look for a mistake they did not make.
   *
   * The error itself is deliberately NOT logged. A pg error carries parameter values
   * in its detail fields, and in this application those parameters are patient data.
   */
  try {
    const db = getDb();
    const { ip: rawIp, userAgent } = await requestMeta();
    const ip = safeInet(rawIp);

    /*
     * Resolve the account. An existing link wins over the email, because `sub` is stable and
     * an email is not: if a departing employee's address is reassigned to their replacement,
     * matching on email would hand over the old account.
     */
    const [linked] = await db
      .select({ userId: userIdentity.userId })
      .from(userIdentity)
      .where(
        and(
          eq(userIdentity.provider, 'google'),
          eq(userIdentity.subject, identity.subject),
        ),
      )
      .limit(1);

    const [account] = linked
      ? await db
          .select({
            id: userAccount.id,
            clinicId: userAccount.clinicId,
            status: userAccount.status,
            lockedUntil: userAccount.lockedUntil,
          })
          .from(userAccount)
          .where(and(eq(userAccount.id, linked.userId), isNull(userAccount.archivedAt)))
          .limit(1)
      : await db
          .select({
            id: userAccount.id,
            clinicId: userAccount.clinicId,
            status: userAccount.status,
            lockedUntil: userAccount.lockedUntil,
          })
          .from(userAccount)
          .where(
            and(eq(userAccount.email, identity.email), isNull(userAccount.archivedAt)),
          )
          .limit(1);

    await recordAttempt({
      email: identity.email,
      ip,
      ...(account ? { userId: account.id, clinicId: account.clinicId } : {}),
      succeeded: Boolean(account) && account!.status === 'active',
    });

    /* No account: the refusal that makes this a link rather than a sign-up. */
    if (!account) return response(FAILURE);

    const now = new Date();
    const locked = account.lockedUntil !== null && account.lockedUntil > now;
    if (locked || account.status !== 'active') {
      await db.transaction(async (tx) => {
        await writeAuditEvent(tx, {
          clinicId: account.clinicId,
          actorUserId: account.id,
          actorIp: ip,
          actorUserAgent: userAgent,
          action: 'auth.login',
          outcome: 'denied',
          entityType: 'user_account',
          entityId: account.id,
          metadata: { via: 'google', reason: locked ? 'locked' : account.status },
        });
      });
      return response(FAILURE);
    }

    const roleCodes = await db
      .select({ code: role.code })
      .from(userRole)
      .innerJoin(role, eq(role.id, userRole.roleId))
      .where(and(eq(userRole.userId, account.id), isNull(userRole.revokedAt)));

    /* Session, identity link and audit row commit together. A session that exists without a
       log line is the thing the audit is meant to make impossible. */
    const created = await db.transaction(async (tx) => {
      await tx
        .update(userAccount)
        .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now })
        .where(eq(userAccount.id, account.id));

      if (linked) {
        await tx
          .update(userIdentity)
          .set({ lastUsedAt: now })
          .where(
            and(
              eq(userIdentity.provider, 'google'),
              eq(userIdentity.subject, identity.subject),
            ),
          );
      } else {
        /* First sign-in for this account: record the link. The administrator created the
           account; this only remembers which Google subject may use it from now on. */
        await tx.insert(userIdentity).values({
          userId: account.id,
          provider: 'google',
          subject: identity.subject,
          emailAtLink: identity.email,
          lastUsedAt: now,
        });

        await writeAuditEvent(tx, {
          clinicId: account.clinicId,
          actorUserId: account.id,
          actorIp: ip,
          actorUserAgent: userAgent,
          /* Its own action, not `auth.login` with a flag in metadata: linking an external
             identity to a staff account is a distinct security event and has to be
             answerable by query rather than by reading JSON out of a thousand logins. */
          action: 'identity.link',
          outcome: 'allowed',
          entityType: 'user_identity',
          entityId: account.id,
          metadata: { provider: 'google' },
        });
      }

      const newSession = await createSession(tx, account.id, ip, userAgent);

      await writeAuditEvent(tx, {
        clinicId: account.clinicId,
        actorUserId: account.id,
        actorRoleCodes: roleCodes.map((r) => r.code),
        actorIp: ip,
        actorUserAgent: userAgent,
        sessionId: newSession.id,
        action: 'auth.login',
        outcome: 'allowed',
        entityType: 'session',
        entityId: newSession.id,
        metadata: { via: 'google' },
      });

      return newSession;
    });

    const success = response('/dashboard');
    success.cookies.set(sessionCookieName(), created.token, {
      ...sessionCookieOptions(),
      expires: created.absoluteExpiresAt,
    });
    return success;
  } catch {
    return response(UNAVAILABLE);
  }
}
