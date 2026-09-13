/**
 * PostgreSQL SQLSTATE codes the application reasons about.
 *
 * Isomorphic — constants and a type guard, no server imports and no PHI — so the
 * database-backed tests can assert against the SAME predicate the application uses. A
 * test that hardcodes '23P01' proves the database emitted a code; a test that runs this
 * function proves the application would have HANDLED it, which is the thing that actually
 * matters to a receptionist looking at the screen.
 *
 * Codes, never messages: message text is localised and reworded between server versions.
 */

/** Two live rows violated an EXCLUDE constraint — the double-booking guard. */
export const EXCLUSION_VIOLATION = '23P01';

/**
 * PostgreSQL chose this transaction as a deadlock victim.
 *
 * NOT hypothetical, and the reason this module exists. Two concurrent bookings for one
 * slot produce a clean 23P01, which is what the original code assumed and what a
 * two-client test shows. Twenty concurrent bookings do not: transactions queue on the
 * GiST index in different orders and some are killed as deadlock victims instead. The
 * database still admits exactly one appointment — the safety guarantee is intact — but
 * the losers arrive with 40P01, and code matching only 23P01 rethrows, turning "that slot
 * just went" into a server error on precisely the busy morning the constraint exists for.
 */
export const DEADLOCK_DETECTED = '40P01';

/** A serialisable transaction could not be ordered. Same user-visible meaning here. */
export const SERIALIZATION_FAILURE = '40001';

/**
 * Every code that means "another transaction won this slot".
 *
 * All three are reported to the user identically and correctly. In each case a competing
 * write for the same provider and overlapping time reached the index first: the caller's
 * appointment does not exist, exactly one does, and the honest thing to say is that the
 * slot has gone. The distinction between them is a detail of how PostgreSQL resolved the
 * contention, not a difference the front desk can act on.
 */
export const SLOT_CONTENTION_CODES: ReadonlySet<string> = new Set([
  EXCLUSION_VIOLATION,
  DEADLOCK_DETECTED,
  SERIALIZATION_FAILURE,
]);

export function sqlStateOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** True when a failed write lost a race for an appointment slot. */
export function isSlotContention(error: unknown): boolean {
  const code = sqlStateOf(error);
  return code !== undefined && SLOT_CONTENTION_CODES.has(code);
}

/**
 * A PHI-free description of a thrown error, for a server log line.
 *
 * ==========================================================================
 * CODES ONLY — NEVER `message`
 * ==========================================================================
 *
 * Measured, not assumed: Drizzle's `DrizzleQueryError` builds its message as the SQL plus
 * `params:` — every bound value, verbatim. A failed query about a patient logs that patient's
 * email, date of birth, or note text if anything prints `error.message`. PostgreSQL's own
 * messages do the same for bad input (`invalid input syntax for type uuid: "…"`), and its
 * `detail` quotes the offending row (`Key (email)=(…) already exists`).
 *
 * So this returns the error's class and its CODE, walking `cause` because Drizzle wraps the
 * driver error that carries it: a SQLSTATE such as `23505`, or a Node errno such as
 * `ECONNREFUSED`. That is enough to tell an outage from a constraint violation from a bug,
 * and it cannot contain anyone's data — the code is validated against a strict shape
 * before it is returned, so even a hostile `code` property cannot smuggle text through.
 */
export function describeError(error: unknown): string {
  const chain: string[] = [];
  let current: unknown = error;

  for (
    let depth = 0;
    depth < 4 && current !== null && current !== undefined;
    depth += 1
  ) {
    const name =
      typeof current === 'object' && current.constructor
        ? current.constructor.name
        : typeof current;
    const raw = (current as { code?: unknown }).code;
    const code = typeof raw === 'string' && /^[A-Z0-9_]{2,40}$/.test(raw) ? raw : null;

    chain.push(code ? `${name}(${code})` : name);
    current = (current as { cause?: unknown }).cause;
  }

  return chain.join(' <- ') || 'unknown';
}
