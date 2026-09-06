import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';

/**
 * Test database access.
 *
 * TWO POOLS, DELIBERATELY. `owner` is the schema owner and can do anything; `app` is
 * `cliniqo_app`, the role the running application actually connects as. Several
 * guarantees under test are GRANT-based — the audit log is append-only because
 * `cliniqo_app` has no UPDATE or DELETE on it — so asserting them through an owner
 * connection would prove nothing at all. Where a test says "rejected", it must be the
 * app role being rejected, or the test is theatre.
 *
 * Raw SQL rather than Drizzle throughout. What is under test is the DATABASE: exclusion
 * constraints, triggers, and privileges. Going through the ORM would test the ORM's
 * ability to emit the statement, and would let a future change to the query builder mask
 * a constraint that had silently stopped existing.
 */

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const TEST_DB = process.env['TEST_DATABASE_NAME'] ?? 'cliniqo_test';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — run tests via \`npm run test:db\`.`);
  return value;
}

export const ownerPool = new Pool({
  connectionString: withDatabase(required('DATABASE_MIGRATION_URL'), TEST_DB),
  ssl: false,
  max: 4,
});

export const appPool = new Pool({
  connectionString: withDatabase(required('DATABASE_URL'), TEST_DB),
  ssl: false,
  max: 25,
});

export async function closePools(): Promise<void> {
  await Promise.all([ownerPool.end(), appPool.end()]);
}

/**
 * The PostgreSQL error code from a rejected statement.
 *
 * Tests assert on the CODE, not the message. Messages are localised and reworded between
 * server versions; `23P01` (exclusion violation) and `42501` (insufficient privilege) are
 * contract. A test matching on prose passes for the wrong reason the day someone rewrites
 * a trigger's RAISE text.
 */
export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export type Baseline = {
  clinicId: string;
  providerId: string;
  otherProviderId: string;
  patientId: string;
  appointmentTypeId: string;
  medicationId: string;
};

/** A unique suffix per call, so repeated seeds cannot collide on unique indexes. */
function tag(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Minimum viable clinic: one clinic, two providers, one patient, one appointment type,
 * one medication. Seeded as OWNER because setup is not what is being tested.
 */
export async function seedBaseline(): Promise<Baseline> {
  const client: PoolClient = await ownerPool.connect();
  try {
    await client.query('BEGIN');

    const t = tag();

    const clinic = await client.query<{ id: string }>(
      `INSERT INTO clinic (name, timezone, mrn_prefix)
       VALUES ($1, 'America/New_York', 'TST') RETURNING id`,
      [`Test Clinic ${t}`],
    );
    const clinicId = clinic.rows[0]!.id;

    const mkUser = async (label: string) => {
      const row = await client.query<{ id: string }>(
        `INSERT INTO user_account (clinic_id, email, password_hash, full_name)
         VALUES ($1, $2, '!', $3) RETURNING id`,
        [clinicId, `${label}-${t}@test.local`, `Test ${label}`],
      );
      return row.rows[0]!.id;
    };

    const providerId = await mkUser('provider');
    const otherProviderId = await mkUser('other');

    const patient = await client.query<{ id: string }>(
      `INSERT INTO patient (clinic_id, mrn, legal_first_name, legal_last_name, date_of_birth)
       VALUES ($1, $2, 'Test', 'Patient', '1990-01-01') RETURNING id`,
      [clinicId, `TST-${t}`],
    );

    const apptType = await client.query<{ id: string }>(
      `INSERT INTO appointment_type (clinic_id, code, display_name, default_duration_minutes)
       VALUES ($1, $2, 'Test Visit', 20) RETURNING id`,
      [clinicId, `TEST_${t.toUpperCase()}`],
    );

    const med = await client.query<{ id: string }>(
      `INSERT INTO medication (name, strength) VALUES ($1, '5mg') RETURNING id`,
      [`Testazole ${t}`],
    );

    await client.query('COMMIT');

    return {
      clinicId,
      providerId,
      otherProviderId,
      patientId: patient.rows[0]!.id,
      appointmentTypeId: apptType.rows[0]!.id,
      medicationId: med.rows[0]!.id,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
