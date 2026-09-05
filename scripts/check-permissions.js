/**
 * Permission matrix drift check.
 *
 * Asserts that the database's role_permission grants exactly match ROLE_PERMISSIONS in
 * src/lib/permissions.ts.
 *
 * This matters more than it looks. At runtime the DATABASE is authoritative — the session
 * resolves permissions from it — while the code list drives the UI and gives compile-time
 * safety. If the two drift, the failure is silent and fails CLOSED: guarded operations
 * start denying, the sidebar keeps showing the links, and it reads like a permissions
 * misconfiguration rather than a code defect. That is an expensive afternoon.
 *
 * Needs a database, so it belongs in the CI job that has one, not in `npm run verify`.
 *
 * Run: node --conditions=react-server scripts/check-permissions.js
 */

import { Pool } from 'pg';

import { PERMISSIONS, ROLE_PERMISSIONS } from '../src/lib/permissions.ts';
import { ROLE_CODES } from '../src/lib/roles.ts';

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('[permissions] DATABASE_MIGRATION_URL is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: url,
  ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: true },
  max: 1,
});

const problems = [];

try {
  const { rows: permRows } = await pool.query(`SELECT code FROM permission`);
  const { rows: roleRows } = await pool.query(`SELECT code FROM "role"`);
  const { rows: grantRows } = await pool.query(
    `SELECT r.code AS role_code, p.code AS permission_code
     FROM role_permission rp
     JOIN "role" r ON r.id = rp.role_id
     JOIN permission p ON p.id = rp.permission_id`,
  );

  /* --- catalogue --- */
  const dbPerms = new Set(permRows.map((r) => r.code));
  const codePerms = new Set(PERMISSIONS);

  for (const code of codePerms) {
    if (!dbPerms.has(code))
      problems.push(`permission "${code}" is in code but not in the database`);
  }
  for (const code of dbPerms) {
    if (!codePerms.has(code))
      problems.push(`permission "${code}" is in the database but not in code`);
  }

  /* --- roles --- */
  const dbRoles = new Set(roleRows.map((r) => r.code));
  for (const code of ROLE_CODES) {
    if (!dbRoles.has(code))
      problems.push(`role "${code}" is in code but not in the database`);
  }
  for (const code of dbRoles) {
    if (!ROLE_CODES.includes(code))
      problems.push(`role "${code}" is in the database but not in code`);
  }

  /* --- grants --- */
  const dbGrants = new Map();
  for (const row of grantRows) {
    if (!dbGrants.has(row.role_code)) dbGrants.set(row.role_code, new Set());
    dbGrants.get(row.role_code).add(row.permission_code);
  }

  for (const roleCode of ROLE_CODES) {
    const expected = new Set(ROLE_PERMISSIONS[roleCode] ?? []);
    const actual = dbGrants.get(roleCode) ?? new Set();

    for (const p of expected) {
      if (!actual.has(p))
        problems.push(`${roleCode}: "${p}" granted in code, MISSING in database`);
    }
    for (const p of actual) {
      if (!expected.has(p))
        problems.push(`${roleCode}: "${p}" granted in database, MISSING in code`);
    }
  }

  /* --- invariants that must hold regardless of what either side says --- */
  const receptionist = dbGrants.get('receptionist') ?? new Set();
  const clinical = [
    'patient.read.clinical',
    'patient.update.clinical',
    'note.read',
    'note.create',
    'note.sign',
    'note.amend',
    'prescription.read',
    'prescription.create',
  ];
  for (const p of clinical) {
    if (receptionist.has(p)) {
      problems.push(
        `INVARIANT: receptionist holds "${p}". Front-desk staff must have no clinical permission (minimum necessary, 164.502(b)).`,
      );
    }
  }

  const admin = dbGrants.get('admin') ?? new Set();
  for (const p of [
    'prescription.create',
    'note.sign',
    'note.create',
    // An administrator may read clinical content but never change it.
    'patient.update.clinical',
    // Prescribing is licensed. An administrator may read prescriptions, never issue one.
    'prescription.create',
    'prescription.cancel',
  ]) {
    if (admin.has(p)) {
      problems.push(
        `INVARIANT: admin holds "${p}". An administrator is not a clinician.`,
      );
    }
  }

  const doctor = dbGrants.get('doctor') ?? new Set();
  if (doctor.has('audit.read')) {
    problems.push(
      'INVARIANT: doctor holds "audit.read". The person who can break glass must not be the person who reviews it.',
    );
  }

  /* --- report --- */
  if (problems.length === 0) {
    console.log(
      `\n  Permission matrix consistent: ${codePerms.size} permissions, ` +
        `${ROLE_CODES.length} roles, ${grantRows.length} grants.\n`,
    );
  } else {
    console.error('\n  Permission matrix DRIFT:\n');
    for (const p of problems) console.error(`    - ${p}`);
    console.error('');
  }
} catch (error) {
  console.error(
    '[permissions] check failed:',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}

if (problems.length > 0) process.exitCode = 1;
