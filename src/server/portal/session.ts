import 'server-only';

import { randomBytes } from 'node:crypto';

import { and, eq, gt, isNull } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { cache } from 'react';

import { getDb } from '@/db/client';
import { clinic, patient, patientAccount, patientSession } from '@/db/schema';
import { getEnv } from '@/env/server';
import { hashToken } from '@/server/auth/session';

/**
 * Patient portal sessions.
 *
 * A deliberate mirror of the staff session module, kept SEPARATE at every layer: its own
 * table (`patient_session`), its own cookie name, its own resolver. A patient session can
 * never resolve to a staff `ActiveSession` and vice versa, because neither reader looks at
 * the other's cookie or table. The two systems share only the pure crypto helper
 * `hashToken` — no shared state, no shared trust.
 *
 * The token itself is the same design as staff: 256 bits of CSPRNG output, stored only as
 * its SHA-256, so a database dump hands over no usable sessions and revocation is a
 * server-side lookup rather than a hope that a JWT expires.
 */

export function portalCookieName(): string {
  const env = getEnv().APP_ENV;
  return env === 'development' || env === 'test'
    ? 'cliniqo_portal'
    : '__Host-cliniqo_portal';
}

export function portalCookieOptions() {
  const env = getEnv();
  const isLocal = env.APP_ENV === 'development' || env.APP_ENV === 'test';
  return {
    httpOnly: true,
    secure: !isLocal,
    sameSite: 'lax' as const,
    path: '/',
  };
}

export type NewPortalSession = { id: string; token: string; absoluteExpiresAt: Date };

type Inserter = { insert: ReturnType<typeof getDb>['insert'] };

/** Create a session row and return the raw token (shown to the browser once, as a cookie). */
export async function createPatientSession(
  tx: Inserter,
  patientAccountId: string,
  userAgent: string | null,
): Promise<NewPortalSession> {
  const env = getEnv();
  const now = Date.now();
  const token = randomBytes(32).toString('base64url');

  const idleExpiresAt = new Date(now + env.SESSION_IDLE_TIMEOUT_MINUTES * 60_000);
  const absoluteExpiresAt = new Date(now + env.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3_600_000);

  const [row] = await tx
    .insert(patientSession)
    .values({
      patientAccountId,
      tokenHash: hashToken(token),
      idleExpiresAt,
      absoluteExpiresAt,
      userAgent,
    })
    .returning({ id: patientSession.id });

  return { id: row!.id, token, absoluteExpiresAt };
}

export async function setPortalCookie(token: string, expiresAt: Date): Promise<void> {
  const jar = await cookies();
  jar.set(portalCookieName(), token, { ...portalCookieOptions(), expires: expiresAt });
}

export async function clearPortalCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(portalCookieName(), '', { ...portalCookieOptions(), maxAge: 0 });
}

/**
 * What a signed-in patient is. No roles, no permissions — a patient's authority is not a
 * set of grants, it is the single `patientId` this account is bound to. Every read and
 * write in the portal is scoped to exactly this id.
 */
export type PatientSession = {
  sessionId: string;
  patientAccountId: string;
  patientId: string;
  clinicId: string;
  clinicName: string;
  clinicTimeZone: string;
  email: string;
  fullName: string;
};

export const getPatientSession = cache(async (): Promise<PatientSession | null> => {
  const jar = await cookies();
  const token = jar.get(portalCookieName())?.value;
  if (!token) return null;

  const db = getDb();
  const now = new Date();

  const [row] = await db
    .select({
      sessionId: patientSession.id,
      lastSeenAt: patientSession.lastSeenAt,
      patientAccountId: patientAccount.id,
      patientId: patientAccount.patientId,
      clinicId: patientAccount.clinicId,
      clinicName: clinic.name,
      clinicTimeZone: clinic.timezone,
      email: patientAccount.email,
      status: patientAccount.status,
      accountArchivedAt: patientAccount.archivedAt,
      firstName: patient.legalFirstName,
      lastName: patient.legalLastName,
      preferredName: patient.preferredName,
      patientArchivedAt: patient.archivedAt,
    })
    .from(patientSession)
    .innerJoin(patientAccount, eq(patientAccount.id, patientSession.patientAccountId))
    .innerJoin(patient, eq(patient.id, patientAccount.patientId))
    .innerJoin(clinic, eq(clinic.id, patientAccount.clinicId))
    .where(
      and(
        eq(patientSession.tokenHash, hashToken(token)),
        isNull(patientSession.revokedAt),
        gt(patientSession.absoluteExpiresAt, now),
        gt(patientSession.idleExpiresAt, now),
      ),
    )
    .limit(1);

  if (!row) return null;

  // A deactivated account, or a patient record archived by staff, ends the session now.
  if (
    row.status !== 'active' ||
    row.accountArchivedAt !== null ||
    row.patientArchivedAt !== null
  ) {
    await db
      .update(patientSession)
      .set({ revokedAt: now })
      .where(eq(patientSession.id, row.sessionId));
    return null;
  }

  // Slide the idle window, throttled to once a minute like staff sessions.
  if (now.getTime() - row.lastSeenAt.getTime() > 60_000) {
    const env = getEnv();
    await db
      .update(patientSession)
      .set({
        lastSeenAt: now,
        idleExpiresAt: new Date(now.getTime() + env.SESSION_IDLE_TIMEOUT_MINUTES * 60_000),
      })
      .where(eq(patientSession.id, row.sessionId));
  }

  const preferred = row.preferredName?.trim();
  return {
    sessionId: row.sessionId,
    patientAccountId: row.patientAccountId,
    patientId: row.patientId,
    clinicId: row.clinicId,
    clinicName: row.clinicName,
    clinicTimeZone: row.clinicTimeZone,
    email: row.email,
    fullName: preferred ? preferred : `${row.firstName} ${row.lastName}`,
  };
});

export async function requirePatientSession(): Promise<PatientSession> {
  const active = await getPatientSession();
  if (!active) throw new Error('PORTAL_UNAUTHENTICATED');
  return active;
}

export async function revokeAllPatientSessions(patientAccountId: string): Promise<void> {
  await getDb()
    .update(patientSession)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(patientSession.patientAccountId, patientAccountId),
        isNull(patientSession.revokedAt),
      ),
    );
}
