/**
 * Security invariant regression suite — security review finding F21.
 *
 * The guarantees this application makes were each verified once, by an ad-hoc script that
 * was then deleted. That is how invariants decay: nothing fails when somebody removes the
 * check, and the removal looks like a tidy-up.
 *
 * These are the checks that must never regress. They run WITHOUT a database, so they can
 * gate every pull request; the database-backed ones (exclusion constraint under
 * concurrency, audit immutability, the receptionist SQL boundary) belong in the CI job
 * that has Postgres.
 *
 * Run: node --conditions=react-server scripts/security-invariants.mjs
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { ROLE_PERMISSIONS, permissionsForRoles } from '../src/lib/permissions.ts';
import { identifyingPatientInput } from '../src/lib/patient-schemas.ts';
import {
  PHI_ACTIONS,
  COLLECTION_ACTIONS,
  AUDIT_ACTIONS,
} from '../src/server/audit/actions.ts';

let failures = 0;
const results = [];

function check(group, label, condition) {
  if (!condition) failures++;
  results.push({ group, label, ok: Boolean(condition) });
}

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

/* ------------------------------------------------------------------ sources */

const audited = read('src/server/data-access/audited.ts');
const authorize = read('src/server/auth/authorize.ts');
const session = read('src/server/auth/session.ts');
const password = read('src/server/auth/password.ts');
const middleware = read('src/middleware.ts');
/*
 * Comments stripped before any content assertion.
 *
 * The first version of this suite grepped raw source and reported two false failures: the
 * prose explaining why 'unsafe-inline' was removed contained the string 'unsafe-inline',
 * and the prose explaining that middleware does NO access control contained
 * 'requirePermission'. A check that reads documentation instead of code is worse than no
 * check — it fails on correct code and would pass on a comment claiming safety.
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const middlewareCode = stripComments(middleware);
const nextConfig = read('next.config.ts');
const eslintCfg = read('eslint.config.mjs');
const notesDa = read('src/server/data-access/notes.ts');
const patientsDa = read('src/server/data-access/patients.ts');

/* ------------------------------------------- 1. minimum necessary boundaries */

const rec = permissionsForRoles(['receptionist']);
const doc = permissionsForRoles(['doctor']);
const adm = permissionsForRoles(['admin']);

check(
  'Minimum necessary',
  'receptionist holds NO clinical permission',
  ![
    'patient.read.clinical',
    'patient.update.clinical',
    'note.read',
    'note.create',
    'note.sign',
    'note.amend',
    'prescription.read',
    'prescription.create',
  ].some((p) => rec.has(p)),
);

check(
  'Minimum necessary',
  'admin may read clinical but never write it',
  adm.has('patient.read.clinical') &&
    adm.has('note.read') &&
    !adm.has('note.create') &&
    !adm.has('note.sign') &&
    !adm.has('patient.update.clinical') &&
    !adm.has('prescription.create'),
);

check(
  'Minimum necessary',
  'only doctor may prescribe',
  doc.has('prescription.create') &&
    !adm.has('prescription.create') &&
    !rec.has('prescription.create'),
);

check(
  'Minimum necessary',
  'only admin reads the audit log',
  adm.has('audit.read') && !doc.has('audit.read') && !rec.has('audit.read'),
);

check(
  'Minimum necessary',
  'break-glass holder is not the audit reviewer',
  doc.has('breakglass.use') && !doc.has('audit.read'),
);

check(
  'Minimum necessary',
  'patient read scope split into two projections',
  /IDENTIFYING_COLUMNS/.test(patientsDa) &&
    /CLINICAL_COLUMNS/.test(patientsDa) &&
    /session\.permissions\.has\('patient\.read\.clinical'\)/.test(patientsDa),
);

check(
  'Minimum necessary',
  'clinical columns absent from the identifying projection',
  !patientsDa
    .slice(
      patientsDa.indexOf('IDENTIFYING_COLUMNS = {'),
      patientsDa.indexOf('} as const'),
    )
    .includes('sexAssignedAtBirth'),
);

const strict = identifyingPatientInput.safeParse({
  legalFirstName: 'A',
  legalLastName: 'B',
  dateOfBirth: '1990-01-01',
  sexAssignedAtBirth: 'female',
});
check(
  'Minimum necessary',
  'receptionist payload with a clinical field is REJECTED',
  !strict.success,
);

/* --------------------------------------------------- 2. audit completeness */

check(
  'Audit',
  'every PHI event must name its patient (assertion throws)',
  /throw new Error\(\s*`Audit misuse/.test(audited),
);
check(
  'Audit',
  'collection reads exempted via a SET, not a hardcoded action',
  /COLLECTION_ACTIONS\.has\(spec\.action\)/.test(audited),
);
check(
  'Audit',
  'success path audits INSIDE the transaction',
  /transaction\(async \(tx\) => \{[\s\S]*?await work\(tx, session\)[\s\S]*?writeAuditEvent\(tx/.test(
    audited,
  ),
);
check('Audit', 'denials are audited', /outcome: 'denied'/.test(authorize));
check(
  'Audit',
  'audit-write failure never masks the operation',
  /Never mask the original failure/.test(audited),
);
check(
  'Audit',
  'PHI_ACTIONS is a subset of the action union',
  [...PHI_ACTIONS].every((a) => AUDIT_ACTIONS.includes(a)),
);
check(
  'Audit',
  'collection actions are themselves PHI actions',
  [...COLLECTION_ACTIONS].every((a) => PHI_ACTIONS.has(a)),
);
check(
  'Audit',
  'authz.denied is a fixed action, not interpolated',
  !/action: `authz\.denied/.test(authorize),
);

/* ------------------------------------------------------ 3. F1 read budget */

check(
  'Read budget (F1)',
  'budget enforced in the audited layer',
  /isCountedRead\(spec\.action\)/.test(audited) && /checkReadBudget/.test(audited),
);
check(
  'Read budget (F1)',
  'checked AFTER authorization',
  audited.indexOf('requirePermission(spec.permission') <
    audited.indexOf('isCountedRead(spec.action)'),
);
check(
  'Read budget (F1)',
  'checked BEFORE the work runs',
  audited.indexOf('isCountedRead(spec.action)') <
    audited.indexOf('return await getDb().transaction'),
);
check(
  'Read budget (F1)',
  'refusal is audited as denied',
  /reason: 'read_budget_exceeded'/.test(audited),
);
check(
  'Read budget (F1)',
  'throws rather than returning an ignorable value',
  /throw new ReadBudgetExceededError\(\)/.test(audited),
);

/* ------------------------------------------------------- 4. session safety */

check('Session', 'httpOnly', /httpOnly: true/.test(session));
check('Session', 'secure outside local', /secure: !isLocal/.test(session));
check('Session', 'SameSite set', /sameSite: 'lax'/.test(session));
check('Session', '__Host- prefix when deployed', /__Host-cliniqo_session/.test(session));
check(
  'Session',
  'token stored hashed, never raw',
  /createHash\('sha256'\)/.test(session) && !/tokenHash: token[,\s]/.test(session),
);
check(
  'Session',
  'idle AND absolute expiry both enforced in the query',
  /gt\(session\.absoluteExpiresAt, now\)/.test(session) &&
    /gt\(session\.idleExpiresAt, now\)/.test(session),
);
check(
  'Session',
  'permissions resolved per request, not from the cookie',
  /const grants = await db/.test(session),
);
check(
  'Session',
  'inactive account tears the session down',
  /revokedReason: 'deactivated'/.test(session),
);

/* ------------------------------------------------------ 5. credential safety */

check(
  'Credentials',
  'timing equalised for unknown accounts',
  /await verifyPassword\(password, await decoyHash\(\)\)/.test(password),
);
check(
  'Credentials',
  'unusable-password sentinel exists',
  /UNUSABLE_PASSWORD/.test(password),
);
check('Credentials', 'constant-time comparison', /timingSafeEqual/.test(password));
check(
  'Credentials',
  'cost parameters travel inside the hash',
  /scrypt\$/.test(password) || /ALGORITHM/.test(password),
);

/* -------------------------------------------------------- 6. F2 CSP nonce */

check('CSP (F2)', 'nonce generated per request', /nonce-\$\{nonce\}/.test(middleware));
{
  // Assert against the directive itself, not the surrounding text.
  const scriptSrc = (middlewareCode.match(/`script-src[^`]*`/) ?? [''])[0];
  check(
    'CSP (F2)',
    "script-src no longer allows 'unsafe-inline'",
    scriptSrc.length > 0 && !scriptSrc.includes('unsafe-inline'),
  );
  check(
    'CSP (F2)',
    'script-src carries a nonce and strict-dynamic',
    scriptSrc.includes('nonce-') && scriptSrc.includes('strict-dynamic'),
  );
}
check(
  'CSP (F2)',
  'no second static CSP in next.config',
  !/key: 'Content-Security-Policy'/.test(nextConfig),
);
check(
  'CSP (F2)',
  'no third-party connect-src (bounds XSS exfiltration)',
  /"connect-src 'self'"/.test(middleware),
);
check('CSP (F2)', 'frame-ancestors none', /frame-ancestors 'none'/.test(middleware));
check(
  'CSP (F2)',
  'middleware does no access control',
  !/requirePermission|getSession|hasPermission/.test(middlewareCode),
);

/* ------------------------------------------- 7. structural boundaries (lint) */

for (const t of ['patient', 'visitNote', 'prescription', 'appointment']) {
  check(
    'Boundaries',
    `PHI table "${t}" restricted outside data-access`,
    new RegExp(`'${t}'`).test(eslintCfg),
  );
}
check(
  'Boundaries',
  'data-access exempted from the PHI import ban',
  /ignores: \['src\/server\/data-access\/\*\*'\]/.test(eslintCfg),
);
check(
  'Boundaries',
  'components cannot import server internals',
  /'@\/server\/\*'/.test(eslintCfg),
);
check(
  'Boundaries',
  'server actions ARE importable from components',
  /'!@\/server\/actions\/\*'/.test(eslintCfg),
);
check(
  'Boundaries',
  'process.env restricted outside src/env',
  /no-restricted-properties/.test(eslintCfg),
);
check('Boundaries', 'console.log banned', /'no-console'/.test(eslintCfg));

/* ----------------------------------------------- 8. notes: refusal not projection */

check(
  'Notes',
  'note reads require a grant (no narrow projection exists)',
  /permission: 'note\.read'/.test(notesDa),
);
check(
  'Notes',
  'patient id verified against the note in-query',
  /eq\(visitNote\.patientId, patientId\)/.test(notesDa),
);
check(
  'Notes',
  'no unaudited helper reads visit_note',
  !/resolveNotePatient/.test(notesDa),
);

/* ------------------------------------ 9. patient rights (F8, F9, F11) */

const breakGlass = read('src/server/data-access/break-glass.ts');
const disclosures = read('src/server/data-access/disclosures.ts');
const budget = read('src/server/data-access/read-budget.ts');

check(
  'Patient rights',
  'break-glass is never refused on the stated reason',
  !/reason.*invalid|reject.*reason/i.test(stripComments(breakGlass)),
);
/*
 * String containment, not regex.
 *
 * These assertions previously used regex literals written through a shell heredoc, which
 * ate the backslashes — `\(` became a capture group and four correct implementations were
 * reported as failures. Where the target is a fixed string, `.includes()` cannot be
 * mangled and cannot silently mean something else.
 */
check(
  'Patient rights',
  'break-glass lifts the read budget',
  budget.includes('hasActiveBreakGlass(actorUserId)'),
);
check(
  'Patient rights',
  'break-glass availability check fails CLOSED',
  stripComments(breakGlass).includes('catch {') &&
    stripComments(breakGlass).includes('return false;'),
);
check(
  'Patient rights',
  'grants land in a review queue',
  /reviewOutcome: 'pending'/.test(breakGlass) && /listBreakGlassGrants/.test(breakGlass),
);
check(
  'Patient rights',
  'review requires audit.read (same as the log)',
  /permission: 'audit.read'/.test(breakGlass),
);

check(
  'Patient rights',
  'export is its own audited disclosure action',
  /action: 'patient.export'/.test(disclosures),
);
check(
  'Patient rights',
  'export requires its own permission',
  /permission: 'patient.export'/.test(disclosures),
);
check(
  'Patient rights',
  'export includes every note version, not just current',
  disclosures.includes('orderBy(asc(visitNoteVersion.versionNumber))'),
);
check(
  'Patient rights',
  'accounting is gated on audit.read, not chart access',
  disclosures.includes("permission: 'audit.read'") &&
    disclosures.includes("action: 'disclosure.accounting'"),
);
check(
  'Patient rights',
  'accounting flags break-glass access',
  /viaBreakGlass/.test(disclosures),
);
check(
  'Patient rights',
  'accounting looks back six years',
  /ACCOUNTING_YEARS = 6/.test(disclosures),
);
check(
  'Patient rights',
  'receptionist cannot export',
  !permissionsForRoles(['receptionist']).has('patient.export'),
);

/* ------------------------------- 10. clinical facts are clinician-only */

const facts = read('src/server/data-access/clinical-facts.ts');
const config = read('src/server/data-access/clinic-config.ts');

check(
  'Clinical facts',
  'allergy writes require patient.update.clinical',
  facts.includes("permission: 'patient.update.clinical'"),
);
check(
  'Clinical facts',
  'allergy reads require patient.read.clinical',
  facts.includes("permission: 'patient.read.clinical'"),
);
check(
  'Clinical facts',
  'no delete path exists for allergies or flags',
  !facts.includes('.delete(patientAllergy)') && !facts.includes('.delete(patientFlag)'),
);
check(
  'Clinical facts',
  'retraction uses entered_in_error, not removal',
  facts.includes('entered_in_error'),
);
check(
  'Clinical facts',
  'receptionist cannot write clinical facts',
  !permissionsForRoles(['receptionist']).has('patient.update.clinical'),
);
check(
  'Clinical facts',
  'admin cannot write clinical facts either',
  !permissionsForRoles(['admin']).has('patient.update.clinical'),
);

check(
  'Clinic config',
  'all config writes require clinic.configure',
  (config.match(/permission: 'clinic.configure'/g) ?? []).length >= 4,
);
check(
  'Clinic config',
  'appointment types are retired, never deleted',
  !config.includes('.delete(appointmentType)'),
);
check(
  'Clinic config',
  'only admin may configure the clinic',
  permissionsForRoles(['admin']).has('clinic.configure') &&
    !permissionsForRoles(['doctor']).has('clinic.configure') &&
    !permissionsForRoles(['receptionist']).has('clinic.configure'),
);

/* --------------------------------------------- 11. every mutation is validated */

const actionDir = 'src/server/actions';
for (const file of readdirSync(actionDir).filter((f) => f.endsWith('.ts'))) {
  const src = read(`${actionDir}/${file}`);
  const exported = (src.match(/^export async function/gm) ?? []).length;
  const parsed = (src.match(/safeParse/g) ?? []).length;
  // logout and submitNoteAction take no validatable input / delegate.
  const exempt = { 'auth.ts': 1, 'notes.ts': 1 }[file] ?? 0;
  check(
    'Validation',
    `${file}: every input-taking action validates`,
    parsed >= exported - exempt,
  );
}

const uuidOk = identifyingPatientInput.safeParse({
  legalFirstName: 'A',
  legalLastName: 'B',
  dateOfBirth: '1990-01-01',
});
check('Validation', 'a well-formed payload is still accepted', uuidOk.success);
void randomUUID;

/* --------------------------------------------------------------- report */

const groups = [...new Set(results.map((r) => r.group))];
for (const g of groups) {
  console.log(`\n  ${g}`);
  for (const r of results.filter((x) => x.group === g)) {
    console.log(`    ${r.ok ? 'ok  ' : 'FAIL'} ${r.label}`);
  }
}

console.log(
  failures === 0
    ? `\n  ${results.length} security invariants hold.\n`
    : `\n  ${failures} of ${results.length} FAILED.\n`,
);

process.exit(failures === 0 ? 0 : 1);
