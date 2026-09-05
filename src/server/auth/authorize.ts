import 'server-only';

import { redirect } from 'next/navigation';

import { getDb } from '@/db/client';
import type { Permission } from '@/lib/permissions';
import { writeAuditEvent, type AuditEntityType } from '@/server/audit/log';

import { getSession, requestMeta, safeInet, type ActiveSession } from './session';

/**
 * THE authorization mechanism.
 *
 * Every protected operation in the application goes through this file — server actions,
 * services, and route guards alike. One implementation means one thing to review and one
 * thing to fix; twenty hand-rolled role checks means twenty chances to get it wrong, and
 * the wrong one will not be the one anybody thinks to look at.
 *
 * Two shapes, same core:
 *
 *   requirePermission()  throws. For server actions and services.
 *   guardPage()          redirects. For route segments.
 *
 * Both DENY BY DEFAULT and both AUDIT THE DENIAL. Neither returns a boolean, on purpose:
 * a boolean can be ignored, and `if (!allowed)` is a line somebody eventually forgets to
 * write. These either hand back a session or stop execution.
 */

/* -------------------------------------------------------------------------- */

export type AuthzFailure = 'UNAUTHENTICATED' | 'FORBIDDEN';

export class AuthorizationError extends Error {
  readonly reason: AuthzFailure;

  constructor(reason: AuthzFailure) {
    // No permission name, no user id, no record id. This message can surface in a
    // response; the detail belongs in the audit log, which only an admin can read.
    super(reason === 'UNAUTHENTICATED' ? 'Not signed in.' : 'Not permitted.');
    this.name = 'AuthorizationError';
    this.reason = reason;
  }
}

/** Extra context recorded on a denial, so the log says what was being reached for. */
export type AuthzContext = {
  /** Populate whenever the operation concerns a patient, even a refused one. */
  subjectPatientId?: string | null;
  entityType?: AuditEntityType | null;
  entityId?: string | null;
  /** Required for break-glass; otherwise the stated business reason, if any. */
  purpose?: string | null;
};

/* -------------------------------------------------------------------------- */

/**
 * Record a refusal.
 *
 * Denials are logged as carefully as successes. `outcome = 'denied'` has its own partial
 * index precisely because an attempted boundary violation is usually the first visible
 * sign of a compromised account or a misconfigured role — and a log that only records
 * what succeeded cannot show you someone probing.
 *
 * Never allowed to break the request it is describing: a failure to write the audit row
 * must still result in a denial, not a 500 that reads as "something went wrong" and
 * invites a retry.
 */
async function auditDenial(
  session: ActiveSession,
  permission: Permission,
  surface: 'action' | 'route',
  context?: AuthzContext,
): Promise<void> {
  try {
    const { ip, userAgent } = await requestMeta();

    await getDb().transaction(async (tx) => {
      await writeAuditEvent(tx, {
        clinicId: session.clinicId,
        actorUserId: session.userId,
        actorRoleCodes: session.roles,
        actorIp: safeInet(ip),
        actorUserAgent: userAgent,
        sessionId: session.sessionId,
        // Fixed action, permission in metadata. Interpolating the permission into the
        // action name would produce an unbounded set of distinct actions and an index
        // nobody can GROUP BY.
        action: 'authz.denied',
        outcome: 'denied',
        subjectPatientId: context?.subjectPatientId ?? null,
        entityType: context?.entityType ?? null,
        entityId: context?.entityId ?? null,
        purpose: context?.purpose ?? null,
        // Names of things, never values of things.
        metadata: { permission, surface, heldRoles: session.roles },
      });
    });
  } catch (error) {
    console.error(
      '[authz] failed to record denial:',
      error instanceof Error ? error.message : 'unknown error',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* For server actions and services                                            */
/* -------------------------------------------------------------------------- */

/**
 * Require a permission, or throw.
 *
 * Call this as the FIRST statement in every protected server action, before touching an
 * argument. A server action is a public HTTP endpoint: reachable by anyone who can reach
 * the app, with any arguments, regardless of what the UI rendered or which layout the
 * caller passed through. It must never trust that something upstream already checked.
 *
 * Returns the session, so callers get the actor for the audit write they are about to
 * make — the permitted path and the logged path are the same path.
 */
export async function requirePermission(
  permission: Permission,
  context?: AuthzContext,
): Promise<ActiveSession> {
  const session = await getSession();

  if (!session) {
    throw new AuthorizationError('UNAUTHENTICATED');
  }

  if (!session.permissions.has(permission)) {
    await auditDenial(session, permission, 'action', context);
    throw new AuthorizationError('FORBIDDEN');
  }

  return session;
}

/**
 * Require any one of several permissions.
 *
 * For operations reachable more than one way — e.g. a chart summary a clinician opens
 * via `patient.read.clinical` and an administrator via `note.read`. The denial records
 * every permission that would have sufficed, so the log explains what was missing.
 */
export async function requireAnyPermission(
  permissions: readonly Permission[],
  context?: AuthzContext,
): Promise<ActiveSession> {
  const session = await getSession();

  if (!session) {
    throw new AuthorizationError('UNAUTHENTICATED');
  }

  const granted = permissions.find((p) => session.permissions.has(p));
  if (!granted) {
    await auditDenial(session, permissions[0]!, 'action', context);
    throw new AuthorizationError('FORBIDDEN');
  }

  return session;
}

/**
 * Authentication only — someone is signed in.
 *
 * For operations every signed-in user may perform on their own account, such as changing
 * their own password. Deliberately named so that reaching for it instead of
 * `requirePermission` is visible in review.
 */
export async function requireAuthenticated(): Promise<ActiveSession> {
  const session = await getSession();
  if (!session) throw new AuthorizationError('UNAUTHENTICATED');
  return session;
}

/* -------------------------------------------------------------------------- */
/* For route segments                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Guard a page.
 *
 * Redirects rather than throwing, because a user who lands on a page they cannot use
 * should see an explanation, not an error boundary.
 *
 * THIS IS NOT THE SECURITY BOUNDARY. It stops navigation and it produces an audit trail,
 * but the data behind the page is protected by the action or service that fetches it —
 * which re-checks independently. Pages can be bypassed; the fetch cannot.
 *
 * `redirect()` works by throwing NEXT_REDIRECT, so it must never be wrapped in a
 * try/catch that swallows it.
 */
export async function guardPage(
  permission: Permission,
  context?: AuthzContext,
): Promise<ActiveSession> {
  const session = await getSession();

  if (!session) {
    redirect('/login');
  }

  if (!session.permissions.has(permission)) {
    await auditDenial(session, permission, 'route', context);
    redirect('/forbidden');
  }

  return session;
}
