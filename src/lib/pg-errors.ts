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
