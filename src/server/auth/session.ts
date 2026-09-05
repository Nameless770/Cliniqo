import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import { and, eq, gt, isNull } from 'drizzle-orm';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';

import { getDb } from '@/db/client';
import {
  clinic,
  permission,
  role,
  rolePermission,
  session,
  userAccount,
  userRole,
} from '@/db/schema';
import { getEnv } from '@/env/server';
import type { RoleCode } from '@/lib/roles';

/* -------------------------------------------------------------------------- */
/* Cookie                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `__Host-` prefix in deployed environments.
 *
 * The prefix is enforced by the browser: a cookie named `__Host-*` is only accepted if it
 * is Secure, Path=/, and has NO Domain attribute. That last part is the valuable one — it
 * makes the cookie un-settable by a sibling subdomain, so an XSS on
 * `marketing.example.com` cannot plant a session for `app.example.com`.
 *
 * Dropped in local development because the prefix requires Secure, and Secure over plain
 * http is inconsistent across browsers on localhost.
 */
export function sessionCookieName(): string {
  return getEnv().APP_ENV === 'development' || getEnv().APP_ENV === 'test'
    ? 'cliniqo_session'
    : '__Host-cliniqo_session';
}

export function sessionCookieOptions() {
  const env = getEnv();
  const isLocal = env.APP_ENV === 'development' || env.APP_ENV === 'test';

  return {
    httpOnly: true, // JavaScript cannot read it; an XSS cannot exfiltrate the session.
    secure: !isLocal, // Never sent over plaintext HTTP.
    /**
     * `lax`, not `strict`.
     *
     * Lax already withholds the cookie from cross-site POST, which is the CSRF case that
     * matters, and Next's Server Actions add an Origin check on top. `strict` would
     * additionally break top-level navigation from any external link, presenting a
     * signed-in user with a login screen for no security gain here.
     */
    sameSite: 'lax' as const,
    path: '/',
  };
}

/* -------------------------------------------------------------------------- */
/* Token                                                                       */
/* -------------------------------------------------------------------------- */

/** 256 bits from the CSPRNG. Not a JWT: see the note on revocation below. */
function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Sessions are opaque random tokens stored as a SHA-256 hash, not signed JWTs.
 *
 * A JWT is self-validating, which means it stays valid until it expires — you cannot
 * revoke one without keeping server-side state anyway, at which point the JWT bought
 * nothing. This application must be able to kill a session the instant an account is
 * deactivated or a role changes, so the lookup is server-side by design.
 *
 * SHA-256 rather than a slow KDF is correct here: the token is 256 bits of CSPRNG output,
 * so there is no dictionary to attack and nothing for a work factor to defend against.
 * Hashing at all is what stops a leaked database dump — or a read replica — from handing
 * over usable sessions.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/* -------------------------------------------------------------------------- */
/* Creation                                                                    */
/* -------------------------------------------------------------------------- */

export type NewSession = { id: string; token: string; absoluteExpiresAt: Date };

type Inserter = {
  insert: ReturnType<typeof getDb>['insert'];
};

export function buildSessionRow(userId: string, ip: string | null, userAgent: string | null) {
  const env = getEnv();
  const now = Date.now();
  const token = generateToken();

  return {
    token,
    values: {
      userId,
      tokenHash: hashToken(token),
      // Automatic logoff, §164.312(a)(2)(iii). Slides forward while the user is working.
      idleExpiresAt: new Date(now + env.SESSION_IDLE_TIMEOUT_MINUTES * 60_000),
      // Independent ceiling; does not slide. A session left open overnight dies.
      absoluteExpiresAt: new Date(now + env.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3_600_000),
      ipAddress: ip,
      userAgent,
    },
  };
}

export async function createSession(
  tx: Inserter,
  userId: string,
  ip: string | null,
  userAgent: string | null,
): Promise<NewSession> {
  const { token, values } = buildSessionRow(userId, ip, userAgent);

  const [row] = await tx.insert(session).values(values).returning({ id: session.id });

  return { id: row!.id, token, absoluteExpiresAt: values.absoluteExpiresAt };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

export type ActiveSession = {
  sessionId: string;
  userId: string;
  clinicId: string;
  clinicName: string;
  email: string;
  fullName: string;
  mustChangePassword: boolean;
  roles: RoleCode[];
  permissions: Set<string>;
};

/**
 * Resolve the current session, or null.
 *
 * Wrapped in React `cache()`, so several Server Components in one render share a single
 * database round trip rather than each re-querying.
 *
 * Roles and permissions are resolved FRESH on every request, never read from the cookie
 * or the session row. That is what makes deactivation and role changes take effect on the
 * next request instead of whenever a token happens to expire — the difference between
 * revoking access and asking nicely.
 */
export const getSession = cache(async (): Promise<ActiveSession | null> => {
  const jar = await cookies();
  const token = jar.get(sessionCookieName())?.value;
  if (!token) return null;

  const db = getDb();
  const now = new Date();

  const [row] = await db
    .select({
      sessionId: session.id,
      idleExpiresAt: session.idleExpiresAt,
      lastSeenAt: session.lastSeenAt,
      userId: userAccount.id,
      clinicId: userAccount.clinicId,
      clinicName: clinic.name,
      email: userAccount.email,
      fullName: userAccount.fullName,
      status: userAccount.status,
      archivedAt: userAccount.archivedAt,
      mustChangePassword: userAccount.mustChangePassword,
    })
    .from(session)
    .innerJoin(userAccount, eq(userAccount.id, session.userId))
    .innerJoin(clinic, eq(clinic.id, userAccount.clinicId))
    .where(
      and(
        eq(session.tokenHash, hashToken(token)),
        isNull(session.revokedAt),
        // Both clocks checked in the query: absolute ceiling and idle window.
        gt(session.absoluteExpiresAt, now),
        gt(session.idleExpiresAt, now),
      ),
    )
    .limit(1);

  if (!row) return null;

  /*
   * The account can change underneath a live session. A suspended, deactivated, or
   * archived user is refused here and their session is torn down immediately rather than
   * left to expire.
   */
  if (row.status !== 'active' || row.archivedAt !== null) {
    await db
      .update(session)
      .set({ revokedAt: now, revokedReason: 'deactivated' })
      .where(eq(session.id, row.sessionId));
    return null;
  }

  const grants = await db
    .select({ roleCode: role.code, permissionCode: permission.code })
    .from(userRole)
    .innerJoin(role, eq(role.id, userRole.roleId))
    .leftJoin(rolePermission, eq(rolePermission.roleId, role.id))
    .leftJoin(permission, eq(permission.id, rolePermission.permissionId))
    .where(and(eq(userRole.userId, row.userId), isNull(userRole.revokedAt)));

  const roles = [...new Set(grants.map((g) => g.roleCode))] as RoleCode[];
  const permissions = new Set(
    grants.map((g) => g.permissionCode).filter((c): c is string => c !== null),
  );

  /*
   * Slide the idle window — but only once a minute. Without the throttle every page view
   * would issue a write, and on a page composed of several Server Components, several.
   */
  if (now.getTime() - row.lastSeenAt.getTime() > 60_000) {
    const env = getEnv();
    await db
      .update(session)
      .set({
        lastSeenAt: now,
        idleExpiresAt: new Date(now.getTime() + env.SESSION_IDLE_TIMEOUT_MINUTES * 60_000),
      })
      .where(eq(session.id, row.sessionId));
  }

  return {
    sessionId: row.sessionId,
    userId: row.userId,
    clinicId: row.clinicId,
    clinicName: row.clinicName,
    email: row.email,
    fullName: row.fullName,
    mustChangePassword: row.mustChangePassword,
    roles,
    permissions,
  };
});

/**
 * The session, or a thrown error.
 *
 * For code paths that have no meaningful unauthenticated behaviour. Note this proves
 * *authentication* only — it says someone is signed in, never that they may read a given
 * record. Authorization is a separate check, per operation (CLAUDE.md rule 2).
 */
export async function requireSession(): Promise<ActiveSession> {
  const active = await getSession();
  if (!active) throw new Error('UNAUTHENTICATED');
  return active;
}

/* -------------------------------------------------------------------------- */
/* Revocation                                                                  */
/* -------------------------------------------------------------------------- */

export async function revokeSession(
  sessionId: string,
  reason: 'logout' | 'idle_timeout' | 'absolute_timeout' | 'role_change' | 'deactivated' | 'admin_revoke',
): Promise<void> {
  await getDb()
    .update(session)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(session.id, sessionId), isNull(session.revokedAt)));
}

/** Every live session for a user. Used when an account is deactivated or roles change. */
export async function revokeAllSessionsForUser(
  userId: string,
  reason: 'role_change' | 'deactivated' | 'admin_revoke',
): Promise<void> {
  await getDb()
    .update(session)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(session.userId, userId), isNull(session.revokedAt)));
}

/* -------------------------------------------------------------------------- */
/* Request metadata                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Client IP, for rate limiting and the audit trail.
 *
 * Reads `x-forwarded-for` because the app runs behind a proxy. That header is
 * client-controllable when nothing strips it, so the deployment MUST have a proxy that
 * overwrites it — otherwise per-IP limiting is bypassed by sending a header. Noted here
 * because it is an infrastructure requirement that looks like an application detail.
 */
export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;

  return { ip: ip || null, userAgent: h.get('user-agent') };
}

/** Postgres `inet` rejects malformed input; a bad header must not 500 the login. */
export function safeInet(ip: string | null): string | null {
  if (!ip) return null;
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/;
  const ipv6 = /^[0-9a-f:]+$/i;
  return ipv4.test(ip) || ipv6.test(ip) ? ip : null;
}
