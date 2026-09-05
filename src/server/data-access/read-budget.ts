import 'server-only';

import { and, eq, gt, inArray, sql } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { auditEvent } from '@/db/schema';
import { getEnv } from '@/env/server';
import { PHI_ACTIONS, type AuditAction } from '@/server/audit/actions';

import { hasActiveBreakGlass } from './break-glass';

/**
 * PHI read budget — the fix for security review finding F1.
 *
 * ==========================================================================
 * WHAT THIS ADDRESSES
 * ==========================================================================
 *
 * Before this, `checkIpRateLimit` guarded exactly two endpoints: login and account claim.
 * Every authenticated data path — patient search, chart reads, note reads, prescription
 * history — had no throttle at all. A signed-in account with stolen credentials, or a
 * departing employee, could loop `getPatient` and read the entire roster at machine speed.
 *
 * Every one of those reads was audited, so the breach was fully reconstructable. That
 * satisfies §164.312(b) and misses the point: the audit log tells you the SIZE of the
 * breach you must disclose within 60 days. It does not stop it happening.
 *
 * ==========================================================================
 * HOW IT WORKS
 * ==========================================================================
 *
 * The counter IS the audit log. `audit_event` already records every PHI read with an
 * actor and a timestamp, and `audit_event_actor_time_idx` is a (actor_user_id,
 * occurred_at DESC) index — so "how many charts has this account opened in ten minutes"
 * is one bounded index range scan, not a new table to maintain.
 *
 * That choice matters for correctness as well as cost: an in-process counter would give
 * an attacker one full budget per replica, and a separate counter table could drift from
 * the log. Counting the log means the throttle and the evidence can never disagree.
 *
 * ==========================================================================
 * WHAT IT IS NOT
 * ==========================================================================
 *
 * It is a ceiling, not anomaly detection. It stops a fast scrape; it does not stop
 * somebody reading fifty charts a day they have no business reading. That is what audit
 * REVIEW is for, which is why `bulkReaders()` below feeds a dashboard tile — the throttle
 * blocks the loud attack, the review catches the quiet one.
 *
 * Sizing is deliberately generous. A busy clinician opens tens of charts in a day; a
 * scraper does thousands in a minute. The default sits in that gap, and a limit that
 * fires on real clinical work would be turned off within a week.
 */

/** Reads that count against the budget: PHI actions that are reads, not writes. */
const COUNTED: readonly AuditAction[] = [
  'patient.read',
  'patient.search',
  'note.read',
  'prescription.read',
  'appointment.read',
  'appointment.search',
  'allergy.read',
  'flag.read',
];

export type BudgetVerdict =
  | { allowed: true }
  | { allowed: false; used: number; limit: number; windowMinutes: number };

export function isCountedRead(action: AuditAction): boolean {
  return PHI_ACTIONS.has(action) && COUNTED.includes(action);
}

/**
 * Has this actor exhausted their read budget?
 *
 * Fails OPEN on a counting error, and says so loudly. A throttle that breaks the
 * application when the count query fails converts a availability blip into a clinic that
 * cannot see patients — and a clinician locked out of a chart mid-consultation is a
 * patient-safety event, which outranks the exfiltration risk this control exists for.
 * The read is still audited either way, so the evidence survives.
 */
export async function checkReadBudget(actorUserId: string): Promise<BudgetVerdict> {
  const env = getEnv();

  /*
   * Emergency access lifts the ceiling (F11).
   *
   * A live break-glass grant means a clinician has stated, on the record, that they need
   * access beyond the ordinary guardrails — and an administrator will read that statement
   * afterwards. Enforcing a throughput limit against someone in that position is how a
   * safeguard becomes a hazard.
   *
   * The reads are still audited, and they are still attributable; what changes is only
   * whether they are refused. `hasActiveBreakGlass` fails CLOSED, so a database problem
   * reinstates the limit rather than removing it.
   */
  if (await hasActiveBreakGlass(actorUserId)) {
    return { allowed: true };
  }
  const windowStart = new Date(Date.now() - env.PHI_READ_WINDOW_MINUTES * 60_000);

  try {
    const [row] = await getDb()
      .select({ used: sql<number>`count(*)::int` })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.actorUserId, actorUserId),
          gt(auditEvent.occurredAt, windowStart),
          inArray(auditEvent.action, COUNTED as unknown as AuditAction[]),
          eq(auditEvent.outcome, 'allowed'),
        ),
      );

    const used = row?.used ?? 0;

    return used >= env.PHI_READ_LIMIT
      ? {
          allowed: false,
          used,
          limit: env.PHI_READ_LIMIT,
          windowMinutes: env.PHI_READ_WINDOW_MINUTES,
        }
      : { allowed: true };
  } catch (error) {
    console.error(
      '[read-budget] count failed, failing open:',
      error instanceof Error ? error.message : 'unknown error',
    );
    return { allowed: true };
  }
}

/**
 * Actors whose read volume in the last 24 hours warrants a look.
 *
 * The detection half of F1. Surfaced on the admin dashboard beside denied-access counts,
 * because a high number here is the shape of either a scrape that stayed under the
 * ceiling or a staff member browsing charts they have no reason to open.
 *
 * Returns counts and user ids — never patient identifiers.
 */
export async function bulkReaders(
  clinicId: string,
): Promise<{ actorUserId: string; reads: number }[]> {
  const env = getEnv();

  const rows = await getDb()
    .select({
      actorUserId: auditEvent.actorUserId,
      reads: sql<number>`count(*)::int`,
    })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.clinicId, clinicId),
        sql`${auditEvent.occurredAt} > now() - interval '24 hours'`,
        inArray(auditEvent.action, COUNTED as unknown as AuditAction[]),
        eq(auditEvent.outcome, 'allowed'),
      ),
    )
    .groupBy(auditEvent.actorUserId)
    .having(sql`count(*) >= ${env.PHI_READ_ALERT_PER_HOUR}`);

  return rows.filter(
    (r): r is { actorUserId: string; reads: number } => r.actorUserId !== null,
  );
}
