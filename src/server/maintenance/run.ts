/*
 * TYPE-ONLY, and extensionless on purpose.
 *
 * TypeScript refuses a `.ts` import extension without `allowImportingTsExtensions`, while
 * `node` refuses an extensionless one. A type-only import satisfies both: TypeScript
 * resolves it, and node's type stripping erases the statement before resolution ever
 * happens. The job list is therefore a parameter rather than an import — which also means
 * a caller can run one job without reaching for the registry.
 */
import type { JobContext, MaintenanceJob } from './jobs';

/**
 * Run the maintenance jobs and leave evidence that they ran.
 *
 * Two properties matter more than the jobs themselves.
 *
 * ONE FAILURE DOES NOT STOP THE REST. Each job is isolated. If partition creation fails
 * because an owner credential is wrong, the 90-day retention still runs — a scheduler that
 * abandons the remaining work on the first error turns one broken job into three, and the
 * two it skipped are the ones with a compliance obligation attached.
 *
 * A FAILURE IS RECORDED, NOT MERELY THROWN. A job that throws still writes a `failed` row.
 * Without it, a silently failing job looks exactly like one that was never scheduled —
 * which is how `pruneAuthAttempts` sat uncalled without anyone noticing.
 *
 * Like jobs.ts, this module is loaded directly by `node` from the maintenance script, so
 * it carries no runtime imports at all.
 */

export type RunReport = {
  job: string;
  outcome: 'succeeded' | 'failed';
  rowsAffected: number;
  detail: string | null;
  durationMs: number;
};

/**
 * The message only, never the whole error.
 *
 * A PostgreSQL error carries `detail` and `where`, which can quote the offending row — and
 * a row here could be a session belonging to an identifiable patient. The message says
 * what broke without copying data into a table that outlives it.
 */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export async function runMaintenance(
  context: JobContext,
  jobs: readonly MaintenanceJob[],
): Promise<RunReport[]> {
  const reports: RunReport[] = [];

  for (const job of jobs) {
    const startedAt = new Date();
    let outcome: 'succeeded' | 'failed' = 'succeeded';
    let rowsAffected = 0;
    let detail: string | null = null;

    try {
      const result = await job.run(context);
      rowsAffected = result.rowsAffected;
      detail = result.detail ?? null;
    } catch (error) {
      outcome = 'failed';
      detail = safeMessage(error);
    }

    const finishedAt = new Date();

    /*
     * Logging is itself guarded. If the database is unreachable that is what broke every
     * job above, and throwing here would replace three useful reports with one connection
     * error — the caller still gets the outcomes, and still exits non-zero.
     */
    try {
      await context.app(
        `INSERT INTO maintenance_run
           (job, started_at, finished_at, outcome, rows_affected, detail)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [job.name, startedAt, finishedAt, outcome, rowsAffected, detail],
      );
    } catch (error) {
      detail = `${detail ?? ''} [run not logged: ${safeMessage(error)}]`.trim();
    }

    reports.push({
      job: job.name,
      outcome,
      rowsAffected,
      detail,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    });
  }

  return reports;
}
