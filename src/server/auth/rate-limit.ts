import 'server-only';

import { and, count, eq, gt, sql } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { authAttempt } from '@/db/schema';
import { getEnv } from '@/env/server';

/**
 * Login rate limiting.
 *
 * TWO limiters, deliberately, because they defeat different attacks:
 *
 *   Per-account  — one address, many passwords. Bounded by `failed_login_count` and
 *                  `locked_until` on user_account (see actions/auth.ts).
 *   Per-IP       — one host, many addresses. Password spraying tries one common password
 *                  across every account it can name, so it never trips a per-account
 *                  counter at all.
 *
 * Either alone leaves an open door. The per-IP budget is deliberately looser than the
 * per-account one, because a whole clinic can share one NAT address and locking out the
 * front desk at 08:00 is its own kind of outage.
 *
 * Backed by the `auth_attempt` table rather than in-process memory: the app runs as
 * several replicas, and an in-memory counter would give an attacker one full budget per
 * container.
 */

export type RateLimitVerdict =
  { allowed: true } | { allowed: false; retryAfterMinutes: number };

/** Per-IP budget as a multiple of the per-account one. */
const IP_BUDGET_MULTIPLIER = 4;

export async function checkIpRateLimit(ip: string | null): Promise<RateLimitVerdict> {
  // No usable IP means no per-IP limiting. The per-account limiter still applies, and
  // failing open here is right: an unidentifiable proxy must not lock out real staff.
  if (!ip) return { allowed: true };

  const env = getEnv();
  const windowStart = new Date(Date.now() - env.AUTH_RATE_LIMIT_WINDOW_MINUTES * 60_000);

  const [row] = await getDb()
    .select({ failures: count() })
    .from(authAttempt)
    .where(
      and(
        eq(authAttempt.ipAddress, ip),
        eq(authAttempt.succeeded, false),
        gt(authAttempt.attemptedAt, windowStart),
      ),
    );

  const budget = env.AUTH_RATE_LIMIT_MAX_ATTEMPTS * IP_BUDGET_MULTIPLIER;

  return (row?.failures ?? 0) >= budget
    ? { allowed: false, retryAfterMinutes: env.AUTH_RATE_LIMIT_WINDOW_MINUTES }
    : { allowed: true };
}

/**
 * Record every attempt, successful or not.
 *
 * Failures feed the limiter. Successes matter too: "succeeded from an address that had
 * just failed forty times" is the shape of a compromised account, and you cannot see it
 * if you only store the failures.
 *
 * `email_attempted` is stored even when no account matches — that is the signal worth
 * having. It is a staff login identifier, not PHI.
 */
export async function recordAttempt(input: {
  email: string;
  ip: string | null;
  userId?: string | null;
  clinicId?: string | null;
  succeeded: boolean;
}): Promise<void> {
  await getDb()
    .insert(authAttempt)
    .values({
      emailAttempted: input.email,
      ipAddress: input.ip,
      userId: input.userId ?? null,
      clinicId: input.clinicId ?? null,
      succeeded: input.succeeded,
    });
}

/**
 * Prune old attempts.
 *
 * This table is operational security telemetry, not an audit record: it holds no PHI and
 * lives on a 90-day clock rather than the audit log's six years. Keeping the two separate
 * is what stops brute-force noise from swamping the compliance log.
 *
 * Called from a scheduled job, not from the request path.
 */
export async function pruneAuthAttempts(): Promise<number> {
  const result = await getDb()
    .delete(authAttempt)
    .where(sql`${authAttempt.attemptedAt} < now() - interval '90 days'`);

  return result.rowCount ?? 0;
}
