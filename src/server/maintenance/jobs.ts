/**
 * Scheduled housekeeping.
 *
 * Three jobs, each making true something the application already claimed:
 *
 *   - 90-day retention on authentication telemetry. The prune function existed and was
 *     never called from anywhere in the codebase.
 *   - Extending the audit partition window. Migration 0001 pre-creates 24 months and its
 *     own comment says "a scheduled job extends this window". There was no such job.
 *   - Deleting dead session rows, which nothing ever removed.
 *
 * ==========================================================================
 * NOTHING HERE TOUCHES `audit_event`
 * ==========================================================================
 *
 * Its rows are kept six years, are append-only by grant, and are pruned by nothing — not
 * this, not an administrator. The partition job only ever CREATES partitions; there is no
 * drop path at all, deliberately, so a mistake in a date calculation cannot become data
 * loss.
 *
 * ==========================================================================
 * WHY THIS FILE IMPORTS NOTHING
 * ==========================================================================
 *
 * No `@/` aliases, no `server-only`, no ORM. These jobs run in a standalone process from
 * cron, holding the owner credential the web tier is never given — so they must load under
 * plain `node`, which resolves neither the project's path alias nor its extensionless
 * imports. Written against an injected executor, the file runs natively with no build step
 * and no new dependency, and the tests drive exactly the code that ships.
 *
 * It also makes each job reviewable as SQL by whoever administers the database, which is
 * the person most likely to be asked whether the retention claim is true.
 */

/** The subset of `pg`'s query interface these jobs need. */
export type Executor = (
  sql: string,
  params?: unknown[],
) => Promise<{ rowCount: number | null; rows: Record<string, unknown>[] }>;

export type JobContext = {
  /**
   * The least-privileged application role. Deletes run here so a job cannot do more than
   * the running application could.
   */
  app: Executor;
  /**
   * The owner role, for DDL only.
   *
   * Injected, never constructed here: `src/` reads no owner credential anywhere, and that
   * boundary is worth more than the convenience of a job opening its own connection.
   */
  owner: Executor;
};

export type JobResult = { rowsAffected: number; detail?: string };

export type MaintenanceJob = {
  /** Stable identifier, recorded in `maintenance_run.job` — renaming one orphans its history. */
  readonly name: string;
  readonly description: string;
  run(context: JobContext): Promise<JobResult>;
};

/* -------------------------------------------------------------------------- */

/** Documented on `auth_attempt` itself: operational telemetry, not an audit record. */
const AUTH_ATTEMPT_RETENTION_DAYS = 90;

/**
 * Authentication telemetry past its retention window.
 *
 * Brute-force noise is useful for days, not years. Keeping it forever would also make the
 * security telemetry larger than the compliance log it exists to keep clean.
 */
export const pruneAuthAttemptsJob: MaintenanceJob = {
  name: 'prune-auth-attempts',
  description: `Delete authentication attempts older than ${AUTH_ATTEMPT_RETENTION_DAYS} days.`,
  async run({ app }): Promise<JobResult> {
    const result = await app(
      `DELETE FROM auth_attempt
        WHERE attempted_at < now() - make_interval(days => $1)`,
      [AUTH_ATTEMPT_RETENTION_DAYS],
    );
    return { rowsAffected: result.rowCount ?? 0 };
  },
};

/**
 * Sessions that are dead and no longer interesting.
 *
 * A session dies when it is revoked or passes its absolute expiry, but it is not deleted
 * at that moment: for a further month the row still answers "was this token live on
 * Tuesday", which is the question asked during an incident. After that the audit log is
 * the permanent record — `audit_event.session_id` deliberately carries no foreign key, so
 * the correlation id outlives the row it points at and "one long session or twelve
 * suspicious ones" stays answerable for the full six years.
 *
 * Both identity systems are swept here. They are separate tables on purpose, and two jobs
 * would be two things to drift apart.
 */
const SESSION_GRACE_DAYS = 30;

export const pruneExpiredSessionsJob: MaintenanceJob = {
  name: 'prune-expired-sessions',
  description: `Delete staff and patient sessions dead for over ${SESSION_GRACE_DAYS} days.`,
  async run({ app }): Promise<JobResult> {
    const clause = `
       WHERE (revoked_at IS NOT NULL AND revoked_at < now() - make_interval(days => $1))
          OR absolute_expires_at < now() - make_interval(days => $1)`;

    const staff = await app(`DELETE FROM "session" ${clause}`, [SESSION_GRACE_DAYS]);
    const patient = await app(`DELETE FROM patient_session ${clause}`, [SESSION_GRACE_DAYS]);

    const staffRows = staff.rowCount ?? 0;
    const patientRows = patient.rowCount ?? 0;
    return {
      rowsAffected: staffRows + patientRows,
      detail: `staff=${staffRows} patient=${patientRows}`,
    };
  },
};

/**
 * Keep the audit partition window open.
 *
 * `audit_event` is range-partitioned by month, with a DEFAULT partition catching anything
 * outside the created range. The DEFAULT is a safety net, not a plan: once rows land in it
 * the partitioning has stopped doing its job, and partitioning is what keeps a six-year
 * table queryable and its retention prunable by month.
 *
 * `cliniqo_create_audit_partition` is idempotent — it returns early when the partition
 * exists — so this is safe to run daily and only does work at a month boundary. Creating
 * them far ahead is free; an empty partition costs one relation.
 *
 * Which months are missing is decided in SQL against the catalogue rather than by
 * generating names here and hoping they match: the month arithmetic and the naming
 * convention both already live in the database, and restating them is how the two drift.
 */
const PARTITION_MONTHS_AHEAD = 24;

export const extendAuditPartitionsJob: MaintenanceJob = {
  name: 'extend-audit-partitions',
  description: `Ensure audit partitions exist ${PARTITION_MONTHS_AHEAD} months ahead.`,
  async run({ owner }): Promise<JobResult> {
    const result = await owner(
      `WITH wanted AS (
         SELECT generate_series(
           date_trunc('month', now())::date,
           (date_trunc('month', now()) + make_interval(months => $1))::date,
           interval '1 month'
         )::date AS month_start
       ),
       missing AS (
         SELECT month_start FROM wanted
          WHERE to_regclass(
                  format('public.%I', 'audit_event_' || to_char(month_start, 'YYYY_MM'))
                ) IS NULL
       )
       SELECT count(cliniqo_create_audit_partition(month_start))::int AS created
         FROM missing`,
      [PARTITION_MONTHS_AHEAD],
    );

    const created = Number(result.rows[0]?.['created'] ?? 0);
    return {
      rowsAffected: created,
      detail: created === 0 ? 'window already open' : `created ${created} partition(s)`,
    };
  },
};

/**
 * The registry.
 *
 * A job absent from this array does not run — which is precisely the bug this feature
 * corrects — so an invariant asserts that every exported job appears here.
 */
export const MAINTENANCE_JOBS: readonly MaintenanceJob[] = [
  pruneAuthAttemptsJob,
  pruneExpiredSessionsJob,
  extendAuditPartitionsJob,
];
