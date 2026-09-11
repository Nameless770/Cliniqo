/**
 * Scheduled maintenance.
 *
 * Run from cron, a Kubernetes CronJob, or your platform's scheduler — daily is right:
 *
 *     node --env-file-if-exists=.env scripts/maintenance.js
 *
 * Exits non-zero if any job failed, so a scheduler that checks exit codes will alert
 * instead of reporting a green run that quietly did nothing. That is the failure this
 * whole feature exists to correct.
 *
 * WHY A SCRIPT AND NOT A ROUTE. Two reasons. The application holds only the reduced
 * `cliniqo_app` credential, and creating an audit partition is DDL that requires the
 * owner — a route able to do it would mean the web tier holding owner rights, which is
 * exactly the privilege split migration 0001 exists to create. And an HTTP endpoint that
 * performs deletions is an endpoint someone can reach; this one needs no authentication
 * because it needs no network.
 *
 * The jobs themselves live in src/server/maintenance/, so they are unit-testable against
 * the real database rather than trapped in a script.
 */

import { Pool } from 'pg';

import { MAINTENANCE_JOBS } from '../src/server/maintenance/jobs.ts';
import { runMaintenance } from '../src/server/maintenance/run.ts';

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[maintenance] ${name} is not set.`);
    process.exit(2);
  }
  return value;
}

const ssl =
  (process.env.DATABASE_SSL ?? 'require') === 'disable' ? false : { rejectUnauthorized: true };

/* The application's own reduced role for the deletes: if a prune can be done without
   owner rights, it is done without them. */
const appPool = new Pool({ connectionString: required('DATABASE_URL'), ssl });

/* The owner, for DDL only. Held by this process for the duration of the run and by
   nothing else, ever. */
const ownerPool = new Pool({ connectionString: required('DATABASE_MIGRATION_URL'), ssl });

const context = {
  app: (query, params) => appPool.query(query, params),
  owner: (query, params) => ownerPool.query(query, params),
};

const started = Date.now();
console.log(`[maintenance] running ${MAINTENANCE_JOBS.length} job(s)…`);

let reports = [];
try {
  reports = await runMaintenance(context, MAINTENANCE_JOBS);
} finally {
  await Promise.allSettled([appPool.end(), ownerPool.end()]);
}

for (const report of reports) {
  const status = report.outcome === 'succeeded' ? 'ok  ' : 'FAIL';
  const detail = report.detail ? ` — ${report.detail}` : '';
  console.log(
    `  ${status} ${report.job.padEnd(24)} ${String(report.rowsAffected).padStart(6)} row(s)` +
      ` in ${report.durationMs}ms${detail}`,
  );
}

const failed = reports.filter((r) => r.outcome === 'failed');
console.log(
  `[maintenance] ${reports.length - failed.length}/${reports.length} succeeded in ${
    Date.now() - started
  }ms`,
);

process.exit(failed.length === 0 ? 0 : 1);
