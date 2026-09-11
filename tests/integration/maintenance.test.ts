import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { appPool, closePools, ownerPool, seedBaseline } from '../helpers/db';

import {
  MAINTENANCE_JOBS,
  extendAuditPartitionsJob,
  pruneAuthAttemptsJob,
  pruneExpiredSessionsJob,
  type JobContext,
} from '@/server/maintenance/jobs';
import { runMaintenance } from '@/server/maintenance/run';

/**
 * Scheduled maintenance.
 *
 * These jobs delete things, which makes them the most dangerous code in the application
 * and the least likely to be noticed when wrong: a prune with an inverted comparison
 * removes the rows it was meant to keep, reports a cheerful count, and nobody looks until
 * an auditor asks for six years of history.
 *
 * So every job is tested for BOTH halves — what it removes and what it must leave — and
 * the audit log's survival is asserted independently of any of them.
 *
 * No mocking. The jobs speak SQL to an injected connection, so the tests hand them the
 * real pools and the assertions are made against the real database.
 */

const context: JobContext = {
  app: (sql, params) => appPool.query(sql, params),
  owner: (sql, params) => ownerPool.query(sql, params),
};

afterAll(async () => {
  await closePools();
});

beforeEach(async () => {
  const owner = await ownerPool.connect();
  try {
    await owner.query('DELETE FROM maintenance_run');
    await owner.query('DELETE FROM auth_attempt');
  } finally {
    owner.release();
  }
});

describe('maintenance jobs', () => {
  it('prunes authentication attempts past 90 days and keeps recent ones', async () => {
    const owner = await ownerPool.connect();
    try {
      await owner.query(
        `INSERT INTO auth_attempt (email_attempted, ip_address, succeeded, attempted_at) VALUES
           ('old@test.local',   '10.0.0.1', false, now() - interval '91 days'),
           ('older@test.local', '10.0.0.1', false, now() - interval '400 days'),
           ('edge@test.local',  '10.0.0.1', false, now() - interval '89 days'),
           ('fresh@test.local', '10.0.0.1', true,  now())`,
      );
    } finally {
      owner.release();
    }

    const result = await pruneAuthAttemptsJob.run(context);
    expect(result.rowsAffected).toBe(2);

    const left = await appPool.query<{ email_attempted: string }>(
      `SELECT email_attempted FROM auth_attempt ORDER BY email_attempted`,
    );
    // The 89-day row is the one that catches an off-by-one in the window.
    expect(left.rows.map((r) => r.email_attempted)).toEqual([
      'edge@test.local',
      'fresh@test.local',
    ]);
  });

  it('prunes dead sessions but spares live and recently-dead ones', async () => {
    const base = await seedBaseline();
    const owner = await ownerPool.connect();
    try {
      await owner.query(
        `INSERT INTO "session" (user_id, token_hash, idle_expires_at, absolute_expires_at, revoked_at)
         VALUES
           ($1, 'h-expired-long', now(), now() - interval '60 days', NULL),
           ($1, 'h-revoked-long', now(), now() + interval '1 day',  now() - interval '60 days'),
           ($1, 'h-revoked-recent', now(), now() + interval '1 day', now() - interval '2 days'),
           ($1, 'h-live', now() + interval '1 hour', now() + interval '8 hours', NULL)`,
        [base.providerId],
      );
    } finally {
      owner.release();
    }

    const result = await pruneExpiredSessionsJob.run(context);
    expect(result.rowsAffected).toBeGreaterThanOrEqual(2);

    const left = await appPool.query<{ token_hash: string }>(
      `SELECT token_hash FROM "session" WHERE token_hash LIKE 'h-%' ORDER BY token_hash`,
    );
    /*
     * A session revoked two days ago still answers "was this token live on Tuesday",
     * which is the question asked during an incident. Deleting it the moment it dies
     * would be correct-looking and wrong.
     */
    expect(left.rows.map((r) => r.token_hash)).toEqual(['h-live', 'h-revoked-recent']);
  });

  it('recreates a missing audit partition', async () => {
    const owner = await ownerPool.connect();
    let victim = '';
    try {
      const row = await owner.query<{ name: string }>(
        `SELECT 'audit_event_' || to_char(
                  (date_trunc('month', now()) + interval '20 months')::date, 'YYYY_MM') AS name`,
      );
      victim = row.rows[0]!.name;
      // Detach before dropping: an empty future partition holds no rows, but this keeps
      // the test honest about never destroying audit data.
      await owner.query(`ALTER TABLE audit_event DETACH PARTITION "${victim}"`);
      await owner.query(`DROP TABLE "${victim}"`);
    } finally {
      owner.release();
    }

    const exists = async () =>
      (
        await appPool.query<{ present: boolean }>(
          `SELECT to_regclass($1) IS NOT NULL AS present`,
          [`public.${victim}`],
        )
      ).rows[0]!.present;

    expect(await exists()).toBe(false);

    const result = await extendAuditPartitionsJob.run(context);
    expect(result.rowsAffected).toBe(1);
    expect(await exists()).toBe(true);

    // Idempotent: a daily run does nothing on the days it has nothing to do.
    expect((await extendAuditPartitionsJob.run(context)).rowsAffected).toBe(0);
  });

  it('never deletes an audit row', async () => {
    /*
     * The assertion this whole file exists to protect. These jobs run daily with the
     * owner credential; a stray DELETE here would be a six-year compliance record quietly
     * disappearing on a schedule.
     */
    const before = await appPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_event`,
    );

    await runMaintenance(context, MAINTENANCE_JOBS);

    const after = await appPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_event`,
    );
    expect(after.rows[0]!.n).toBeGreaterThanOrEqual(before.rows[0]!.n);
  });
});

describe('the maintenance runner', () => {
  it('records one row per job, with counts and timings', async () => {
    const reports = await runMaintenance(context, MAINTENANCE_JOBS);
    expect(reports).toHaveLength(MAINTENANCE_JOBS.length);

    const logged = await appPool.query<{ job: string; outcome: string }>(
      `SELECT job, outcome FROM maintenance_run ORDER BY started_at`,
    );
    expect(logged.rows.map((r) => r.job)).toEqual(MAINTENANCE_JOBS.map((j) => j.name));
    expect(logged.rows.every((r) => r.outcome === 'succeeded')).toBe(true);
  });

  it('records a failure and still runs the jobs after it', async () => {
    /*
     * The property that turns three coupled jobs into three independent ones. A broken
     * owner credential must not cost the 90-day retention its run.
     */
    const exploding = {
      name: 'always-fails',
      description: 'test double',
      run: () => Promise.reject(new Error('upstream exploded')),
    };

    const reports = await runMaintenance(context, [exploding, pruneAuthAttemptsJob]);

    expect(reports[0]!.outcome).toBe('failed');
    expect(reports[0]!.detail).toContain('upstream exploded');
    expect(reports[1]!.outcome).toBe('succeeded');

    const logged = await appPool.query<{ job: string; outcome: string }>(
      `SELECT job, outcome FROM maintenance_run ORDER BY started_at`,
    );
    // A failure that leaves no row is indistinguishable from a job never scheduled.
    expect(logged.rows).toEqual([
      { job: 'always-fails', outcome: 'failed' },
      { job: 'prune-auth-attempts', outcome: 'succeeded' },
    ]);
  });

  it('keeps the run log append-only for the application role', async () => {
    await runMaintenance(context, [pruneAuthAttemptsJob]);

    // 42501 = insufficient_privilege. The evidence of enforcement must not be editable
    // by the process doing the enforcing.
    await expect(appPool.query('DELETE FROM maintenance_run')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      appPool.query(`UPDATE maintenance_run SET outcome = 'succeeded'`),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('the maintenance script', () => {
  /*
   * The script is what cron actually runs, and it is the one piece the job tests above do
   * not touch: the pools, the two credentials, the exit code. A green suite over an entry
   * point nobody executes is how the original prune function stayed dead, so the
   * deliverable itself gets run here.
   */
  it('runs end to end and exits zero', async () => {
    const run = promisify(execFile);
    const testDb = process.env['TEST_DATABASE_NAME'] ?? 'cliniqo_test';
    const point = (url: string) => {
      const parsed = new URL(url);
      parsed.pathname = `/${testDb}`;
      return parsed.toString();
    };

    const { stdout } = await run(process.execPath, ['scripts/maintenance.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        APP_ENV: 'test',
        DATABASE_URL: point(process.env['DATABASE_URL']!),
        DATABASE_MIGRATION_URL: point(process.env['DATABASE_MIGRATION_URL']!),
      },
    });

    expect(stdout).toContain('3/3 succeeded');

    const logged = await appPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM maintenance_run`,
    );
    expect(logged.rows[0]!.n).toBe(3);
  }, 30_000);
});
