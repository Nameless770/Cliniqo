/**
 * Maintenance run log.
 *
 * WHY THIS TABLE EXISTS. The application states, in several places and in its own
 * documentation, that authentication telemetry is kept for 90 days and that audit
 * partitions are extended by a scheduled job. Until now neither was true: the prune
 * function was written and never called, and the partition job did not exist at all. A
 * retention claim nobody can evidence is worse than no claim — it is the kind of thing an
 * auditor asks to see proof of, and "the code has a function for it" is not proof.
 *
 * So every run records itself here: what ran, when, how long, how many rows it touched,
 * and whether it failed. That makes "we enforce a 90-day retention" a query rather than an
 * assertion.
 *
 * NOT the audit log, and deliberately separate from it. `audit_event` answers "who touched
 * which patient's record"; every row there is scoped to a clinic and an actor. These are
 * cluster-wide housekeeping operations with no clinic, no human actor, and no PHI —
 * putting them in the audit log would dilute the one table whose signal has to stay clean
 * under a six-year retention and a 60-day breach clock.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { maintenanceOutcome } from './enums';
import { primaryId } from './shared';

export const maintenanceRun = pgTable(
  'maintenance_run',
  {
    id: primaryId(),

    /** The job's registered name, e.g. `prune-auth-attempts`. */
    job: text('job').notNull(),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),

    outcome: maintenanceOutcome('outcome').notNull(),

    /** Rows deleted, or partitions created. Zero is a normal, healthy result. */
    rowsAffected: integer('rows_affected').notNull().default(0),

    /**
     * A short note, or the error's message on failure.
     *
     * Never PHI: these jobs operate on sessions, login attempts and partition names, none
     * of which identify a patient. The one way PHI could arrive here is a database error
     * string echoing a row, so failures record the error MESSAGE only — never the detail
     * or the offending values.
     */
    detail: text('detail'),
  },
  (t) => [
    /** "When did this job last succeed?" — the only question anyone asks of this table. */
    index('maintenance_run_job_idx').on(t.job, t.startedAt.desc()),
    check(
      'maintenance_run_finished_after_started',
      sql`${t.finishedAt} is null or ${t.finishedAt} >= ${t.startedAt}`,
    ),
  ],
);
