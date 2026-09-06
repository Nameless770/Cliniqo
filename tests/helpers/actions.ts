import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';

import * as schema from '@/db/schema';
import { permissionsForRoles } from '@/lib/permissions';
import type { RoleCode } from '@/lib/roles';
import type { ActiveSession } from '@/server/auth/session';

import { appPool } from './db';

/**
 * Harness for driving the real server-action / audited-data-access layer against the test
 * database, with a synthetic session.
 *
 * WHY THIS EXISTS. The db/ tests prove database guarantees (constraints, grants, triggers)
 * with raw SQL. They cannot catch the class of bug that dominated this project: a feature
 * fully built and completely dead — an unwired action, a missing audit subject, a
 * server-timezone parse — because the fault lives one layer up, in the audited path, not
 * in the SQL. Every one of those shipped green and was found by hand. A test that runs an
 * action THROUGH `auditedWrite` with a real session and a real database is the thing that
 * catches them automatically. That is what this enables.
 *
 * TWO SEAMS are stood in for, and only two, because everything else must be the real code:
 *
 *   1. `getDb()` — repointed at the test database. `testDb` below is a Drizzle client over
 *      the app-role pool (`cliniqo_app` on `cliniqo_test`), typed identically to the real
 *      `Db` because it is built from the same schema, so the audited layer's transactions
 *      run unchanged against test data.
 *
 *   2. `getSession()` — replaced by whatever `actingAs` last set. In the app this reads a
 *      cookie; there is no cookie in a node test. The session object is otherwise the real
 *      shape, and its `permissions` come from the real `permissionsForRoles`, so a test
 *      cannot accidentally grant itself access the app would refuse.
 *
 * The test file wires these with `vi.mock('@/db/client')` and `vi.mock(
 * '@/server/auth/session')`, delegating to `testDb` and `currentSession` here.
 */

/**
 * Drizzle over the app-role test pool. Same `{ schema }` as `createDb` in src/db/client,
 * so its type is the same `NodePgDatabase<typeof schema>` the real `getDb` returns and the
 * mock is assignable without a cast.
 */
export const testDb = drizzle(appPool, { schema });

let session: ActiveSession | null = null;

/** Read by the mocked `getSession`. A live getter, so `actingAs` takes effect at once. */
export function currentSession(): ActiveSession | null {
  return session;
}

/** Set (or clear, with null) the session the next audited operation will see. */
export function actingAs(next: ActiveSession | null): void {
  session = next;
}

/**
 * A session for `role`, anchored to real seeded ids so the audit foreign keys resolve.
 *
 * Permissions come from the shipping matrix, never hand-listed — a test that assumed a
 * receptionist could read notes would then pass while the app refuses, which is the exact
 * drift these tests exist to prevent.
 */
export function makeSession(
  role: RoleCode,
  ids: { userId: string; clinicId: string },
): ActiveSession {
  return {
    sessionId: randomUUID(),
    userId: ids.userId,
    clinicId: ids.clinicId,
    clinicName: 'Test Clinic',
    clinicTimeZone: 'America/New_York',
    email: `${role}@test.local`,
    fullName: `Test ${role}`,
    mustChangePassword: false,
    roles: [role],
    permissions: permissionsForRoles([role]),
  };
}
