import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { describeError } from '@/lib/pg-errors';

/**
 * The line between "an operator can diagnose this" and "a log file now holds PHI".
 *
 * Written against a REAL Drizzle error rather than a hand-built one, because the danger
 * was only found by measuring it: `DrizzleQueryError` puts every bound parameter into its
 * `message`. A test using `new Error('boom')` would pass whatever `describeError` did with
 * messages, and so would prove nothing about the case that matters.
 *
 * Port 1 on loopback refuses immediately on every platform, so this needs no database and
 * cannot hang.
 */
describe('describing an error for a log line', () => {
  it('keeps the parameters of a failed query out, and the cause code in', async () => {
    const pool = new Pool({
      connectionString: 'postgres://nobody:nothing@127.0.0.1:1/none',
      ssl: false,
      connectionTimeoutMillis: 2_000,
    });

    /* Values shaped like what these paths really bind: an address, and free text a
       clinician typed as a break-glass justification. Synthetic, per §164.514. */
    const email = 'synthetic.patient@example.invalid';
    const purpose = 'Unresponsive in waiting room, checking penicillin allergy';

    let caught: unknown;
    try {
      await drizzle(pool).execute(sql`select ${email}, ${purpose}`);
    } catch (error) {
      caught = error;
    } finally {
      await pool.end();
    }

    // The premise: the raw message really does carry the parameters.
    expect(String((caught as Error).message)).toContain(email);

    const described = describeError(caught);
    expect(described).not.toContain(email);
    expect(described).not.toContain('penicillin');
    // And still says what went wrong — the whole reason to log anything.
    expect(described).toMatch(/ECONNREFUSED/);
  });

  it('refuses a code that is not shaped like a code', () => {
    /*
     * `code` is just a property. Anything can set it, including a library that puts a
     * value there, so it is validated rather than trusted.
     */
    const hostile = Object.assign(new Error('x'), {
      code: 'synthetic.patient@example.invalid',
    });
    expect(describeError(hostile)).toBe('Error');
  });

  it('reads a SQLSTATE and walks a chain of causes', () => {
    const driver = Object.assign(new Error('duplicate key value'), { code: '23505' });
    const wrapped = new Error('Failed query: insert ...', { cause: driver });
    expect(describeError(wrapped)).toBe('Error <- Error(23505)');
  });

  it('copes with things that are not errors at all', () => {
    expect(describeError('boom')).toBe('string');
    expect(describeError(null)).toBe('unknown');
    expect(describeError(undefined)).toBe('unknown');
  });
});
