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
import { NAV_ITEMS } from '../src/lib/roles.ts';
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
const staffDa = read('src/server/data-access/staff.ts');
const staffLayout = read('src/app/(staff)/layout.tsx');

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

/* --------------------------------- 2b. every PHI write names its subject */

/*
 * The audited layer throws at runtime when a PHI, non-collection action is logged with no
 * `subjectPatientId` — but a throw only fires when the code path RUNS. Three appointment
 * mutations (status, check-in, reschedule) shipped with this bug and never tripped it,
 * because their buttons 500'd on the first click and nobody had wired a test. Cancel and
 * reschedule inherited it the moment their UI went in.
 *
 * This is that runtime assertion, moved to build time: scan every audited spec in the
 * data-access layer and, when its action must name a patient, require `subjectPatientId`
 * in the same spec. It reads the spec object between the `audited*(` open and the async
 * callback that follows — the actual code, not a comment.
 */
{
  const requiresSubject = new Set(
    [...PHI_ACTIONS].filter((a) => !COLLECTION_ACTIONS.has(a)),
  );

  const daDir = 'src/server/data-access';
  const offenders = [];

  // Extract the full balanced parenthesised call starting at `open` (index of the "(").
  const balancedCall = (src, open) => {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) return src.slice(open, i + 1);
      }
    }
    return src.slice(open);
  };

  for (const file of readdirSync(daDir).filter((f) => f.endsWith('.ts'))) {
    const src = stripComments(read(`${daDir}/${file}`));
    const callRe = /audited(?:Write|Read|Operation|Search)\s*\(/g;
    let m;
    while ((m = callRe.exec(src)) !== null) {
      const openParen = src.indexOf('(', m.index);
      const call = balancedCall(src, openParen);

      // The spec object is everything up to the async work callback.
      const cut = call.search(/async\s*\(\s*tx\b/);
      const spec = cut === -1 ? call.slice(0, 600) : call.slice(0, cut);

      const actionMatch = spec.match(/action:\s*'([^']+)'/);
      if (!actionMatch) continue; // auditedSearch may default its action; not our concern
      const action = actionMatch[1];
      if (!requiresSubject.has(action)) continue;

      // Satisfied by an explicit subject in the spec, OR a subject RESOLVER passed after
      // the work callback — `(result) => result.id` for a creation, which names the row it
      // just inserted. This mirrors the runtime `subjectDeferred` branch exactly.
      const hasSubject = spec.includes('subjectPatientId');
      const afterWork = cut === -1 ? '' : call.slice(cut);
      const hasResolver = /=>\s*\w+\.id\b/.test(afterWork);

      if (!hasSubject && !hasResolver) offenders.push(`${file}:${action}`);
    }
  }

  check(
    'Audit',
    `every single-patient PHI write names its subject${offenders.length ? ` (missing: ${offenders.join(', ')})` : ''}`,
    offenders.length === 0,
  );
}

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

  /*
   * 'unsafe-eval' is allowed in DEVELOPMENT only — React's dev build needs eval() to
   * reconstruct stack traces across the server/client boundary, and denying it only
   * destroys error messages.
   *
   * This asserts it can never reach production: it must not sit in the directive
   * unconditionally, and its only path in must be behind a NODE_ENV === 'development'
   * comparison, which the bundler folds to a literal false in a production build.
   * Fixed-string .includes(), not a regex — see the note at the top of this file.
   */
  const mentionsEval = middlewareCode.includes('unsafe-eval');
  check(
    'CSP (F2)',
    "'unsafe-eval' is absent, or development-gated and never in the directive",
    !mentionsEval ||
      (!scriptSrc.includes('unsafe-eval') &&
        middlewareCode.includes("process.env.NODE_ENV === 'development'")),
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
  /ignores: \[[^\]]*'src\/server\/data-access\/\*\*'/.test(eslintCfg),
);
/*
 * The patient portal is a SECOND surface allowed to touch patient tables directly. That is
 * a deliberate loosening — a patient acting on their own record has no staff permission and
 * cannot use the staff audited layer — so it must pay for itself: every PHI access in the
 * portal writes its own audit row. This asserts that self-auditing exists, so the exemption
 * cannot quietly become an unaudited hole.
 */
{
  const portalExempted = /'src\/server\/portal\/\*\*'/.test(eslintCfg);
  const portalData = read('src/server/portal/data.ts');
  check(
    'Boundaries',
    'if the portal is exempted, its PHI access is self-audited',
    !portalExempted ||
      (portalData.includes('auditAsPatient') &&
        portalData.includes('actorPatientAccountId')),
  );
}
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
  /*
   * Actions with no input to validate. Named individually, because this map is the one
   * place a genuinely missing zod schema could hide behind a number:
   *   auth.ts        logout()
   *   notes.ts       submitNoteAction() — delegates
   *   portal.ts      portal logout()
   *   mfa.ts         beginEnrollmentAction() — takes no arguments at all
   */
  const exempt = { 'auth.ts': 1, 'notes.ts': 1, 'portal.ts': 1, 'mfa.ts': 1 }[file] ?? 0;
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

/* ------------------------------------------------- Forced password change */

/*
 * `must_change_password` was stored, selected into the session, and read by NOTHING for
 * several phases. A credential somebody else has seen is a shared login until it is
 * replaced, which 164.312(a)(2)(i) does not permit — so the flag has to actually stop
 * the user, and a self-service change has to exist for them to satisfy it.
 *
 * Fixed-string .includes(), not regexes — see the note at the top of this file.
 */
{
  const layoutCode = stripComments(staffLayout);
  const staffCode = stripComments(staffDa);

  check(
    'Password change',
    'must_change_password actually gates the staff layout',
    layoutCode.includes('active.mustChangePassword') &&
      layoutCode.includes('redirect(PASSWORD_CHANGE_PATH)'),
  );
  check(
    'Password change',
    'the change page itself is exempt (no redirect loop)',
    layoutCode.includes('pathname !== PASSWORD_CHANGE_PATH'),
  );
  check(
    'Password change',
    'changing a password re-authenticates with the current one',
    staffCode.includes('verifyPassword(currentPassword') &&
      staffCode.includes("reason: 'wrong_password'"),
  );
  check(
    'Password change',
    'a failed re-authentication is audited',
    staffCode.includes("reason: 'wrong_current_password'"),
  );
  check(
    'Password change',
    'a successful change revokes every session',
    staffCode.includes('revokeAllSessionsForUser(active.userId'),
  );
  check(
    'Password change',
    'an account with no usable password cannot self-serve',
    staffCode.includes('UNUSABLE_PASSWORD') &&
      staffCode.includes("reason: 'no_password_set'"),
  );
}

/* ------------------------------------------------- Form input boundaries */

/*
 * Two rules that each cost a real, silent failure to learn.
 *
 * 1. NO ACTION PARSES RAW FormData. React ships its server-action encoding in the same
 *    FormData as the user's input ($ACTION_REF_n, $ACTION_n:m, $ACTION_KEY). Against a
 *    .strict() schema those become an `unrecognized_keys` issue with an EMPTY path, which
 *    lands under `_form` — a key no form renders. The observed symptom was a "Book
 *    appointment" button that did nothing at all: no row, no error, no message. Every
 *    action must go through `formFields()`, which strips them.
 *
 * 2. APPOINTMENT TIMES ARE CONVERTED IN THE CLINIC'S ZONE. `new Date('2027-06-15T09:00')`
 *    reads an offset-less string in the SERVER's timezone, so the instant a patient is
 *    booked for depended on how the container was configured — seven hours out between a
 *    New York clinic and a developer in Africa/Cairo. `zonedWallClock` takes the clinic
 *    timezone explicitly.
 */
{
  const actionFiles = readdirSync('src/server/actions').filter((f) => f.endsWith('.ts'));
  const rawParsers = actionFiles.filter((f) =>
    stripComments(read(`src/server/actions/${f}`)).includes(
      'Object.fromEntries(formData.entries())',
    ),
  );
  check(
    'Form input',
    `no action parses raw FormData${rawParsers.length ? ` (${rawParsers.join(', ')})` : ''}`,
    rawParsers.length === 0,
  );

  const usesHelper = actionFiles.filter((f) =>
    stripComments(read(`src/server/actions/${f}`)).includes('formFields(formData)'),
  );
  check(
    'Form input',
    `actions validate through formFields (${usesHelper.length} files)`,
    usesHelper.length > 0,
  );

  const patientSchemas = stripComments(read('src/lib/patient-schemas.ts'));
  check(
    'Form input',
    'formFields strips the framework prefix',
    patientSchemas.includes("key.startsWith('$ACTION')"),
  );

  const apptDa = stripComments(read('src/server/data-access/appointments.ts'));
  check(
    'Form input',
    'appointment times converted in the clinic timezone',
    apptDa.includes('zonedWallClock(input.startsAt, session.clinicTimeZone)') &&
      apptDa.includes('zonedWallClock(startsAt, session.clinicTimeZone)'),
  );
  check(
    'Form input',
    'no server-timezone parse of a submitted appointment time',
    !apptDa.includes('new Date(input.startsAt)') &&
      !apptDa.includes('new Date(startsAt)'),
  );
}

/* --------------------------------------------------- Unreachable actions */

/*
 * Every exported server action must be reachable from the UI.
 *
 * This session found three features fully built, validated, audited — and callable by
 * nothing: the allergy write path, `startNoteAction`, and the five listed below. The code
 * was correct in every case; it simply had no caller, so the feature did not exist. No
 * type error, no lint error, no invariant caught any of them, because nothing is WRONG
 * with an uncalled function.
 *
 * Reachability is transitive: `submitNoteAction` dispatches to `saveDraftAction` and
 * `signNoteAction` by intent, so those count as reached. Bodies are sliced per function
 * rather than per file — otherwise one reachable action vouches for every neighbour that
 * happens to share its module.
 *
 * KNOWN_UNWIRED is DEBT, not approval. Each entry is a server action with no user-facing
 * path, listed so the check fails on NEW ones instead of being disabled. Deleting an entry
 * without building its UI turns this check red, which is the point.
 */
{
  const walkSrc = (dir, acc = []) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walkSrc(p, acc);
      else if (/\.(tsx|ts)$/.test(entry.name)) acc.push(p);
    }
    return acc;
  };

  /*
   * Empty, and it should stay that way. Every one of these was wired up:
   *   - reschedule / cancel appointment -> StatusActions reveals on the schedule
   *   - archive / restore patient       -> ArchiveControls on the chart
   *   - cancel prescription             -> PrescriptionActions on the chart
   *
   * KNOWN NOTE ON THIS CHECK'S REACH. It confirms the SYMBOL appears in the UI, not that
   * the branch using it is live. `correctPrescriptionAction` passed here for weeks while
   * dead: PrescribeForm imported it behind `correcting ? correct : create`, and no page
   * ever set `correcting`. That is now wired (the prescribe page reads ?correct=), but
   * the blind spot is real — a symbol in an unreachable branch still counts as reached.
   */
  const KNOWN_UNWIRED = new Set([]);

  const uiText = [...walkSrc('src/app'), ...walkSrc('src/components')]
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  const bodyOf = new Map();
  const DECL = /export async function ([A-Za-z0-9_]+)/g;
  for (const f of walkSrc('src/server/actions')) {
    const src = readFileSync(f, 'utf8');
    const hits = [...src.matchAll(DECL)];
    hits.forEach((m, i) => {
      const end = i + 1 < hits.length ? hits[i + 1].index : src.length;
      bodyOf.set(m[1], src.slice(m.index, end));
    });
  }

  const names = [...bodyOf.keys()];
  // Fixed-string .includes(), never a built regex - see the note at the top of this file.
  const reachable = new Set(names.filter((n) => uiText.includes(n)));

  let grew = true;
  while (grew) {
    grew = false;
    for (const n of names) {
      if (reachable.has(n)) continue;
      for (const r of reachable) {
        if (r !== n && bodyOf.get(r).includes(n)) {
          reachable.add(n);
          grew = true;
          break;
        }
      }
    }
  }

  const orphans = names.filter((n) => !reachable.has(n) && !KNOWN_UNWIRED.has(n));
  check(
    'Reachability',
    `no NEW unreachable server action${orphans.length ? ` (found: ${orphans.join(', ')})` : ''}`,
    orphans.length === 0,
  );

  // Guards the guard: if someone wires one up, the stale entry must be removed.
  const staleDebt = [...KNOWN_UNWIRED].filter((n) => reachable.has(n));
  check(
    'Reachability',
    `KNOWN_UNWIRED has no stale entries${staleDebt.length ? ` (now wired: ${staleDebt.join(', ')})` : ''}`,
    staleDebt.length === 0,
  );

  check(
    'Reachability',
    `every action still accounted for (${names.length} total, ${KNOWN_UNWIRED.size} unwired)`,
    names.length > 0,
  );
}

/* ------------------------------------------------------- Navigation targets */

/*
 * Every sidebar link must resolve to a page that exists.
 *
 * Not a security property in itself, but it is here because the failure mode was real and
 * long-lived: /notes and /prescriptions sat in the sidebar for three phases returning 404,
 * and nothing failed. A broken link to a clinical worklist is a feature nobody can use and
 * a control nobody can exercise — the unsigned-notes queue exists so notes are not
 * silently forgotten, which it cannot do while it 404s.
 *
 * Routes are resolved from the filesystem rather than hardcoded, so adding a route group
 * or moving a page keeps the check honest.
 */
{
  const routes = new Set();

  const walk = (dir, route) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        if (/^page\.(tsx|ts|jsx|js)$/.test(entry.name)) routes.add(route || '/');
        continue;
      }
      const seg = entry.name;
      // Route groups "(staff)" and private folders "_components" add no URL segment.
      const nextRoute =
        seg.startsWith('(') && seg.endsWith(')') ? route : `${route}/${seg}`;
      if (seg.startsWith('_')) continue;
      walk(`${dir}/${seg}`, nextRoute);
    }
  };

  if (existsSync('src/app')) walk('src/app', '');

  const missing = NAV_ITEMS.filter((item) => !routes.has(item.href)).map((i) => i.href);

  check(
    'Navigation',
    `every sidebar link resolves${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`,
    missing.length === 0,
  );
}

/* ------------------------------------------------- Transaction concurrency */

/*
 * No `Promise.all` over a transaction client.
 *
 * A Drizzle transaction is bound to ONE node-postgres client, and a client runs one query
 * at a time — concurrent calls land on its internal queue. So `Promise.all([tx.select(),
 * tx.select()])` is not concurrent: measured against this project's own database, three
 * 400ms sleeps took 1226ms through `Promise.all` on a transaction client and 1207ms
 * sequentially, versus 414ms on a pool where each query gets its own connection.
 *
 * It costs nothing and breaks twice. Today it emits a deprecation warning on every call;
 * in pg@9 the queue is removed and the second query throws — which, inside `auditedWrite`,
 * means a clinical write and its audit row failing together at runtime on a version bump.
 *
 * The pool is the exception and stays allowed: `db.select()` outside a transaction draws a
 * separate connection per query, so there the concurrency is real. This checks only for a
 * `tx` receiver inside a `Promise.all` argument list.
 */
{
  const dataFiles = [
    ...readdirSync('src/server/data-access').map((f) => `src/server/data-access/${f}`),
    ...readdirSync('src/server/portal').map((f) => `src/server/portal/${f}`),
  ].filter((p) => p.endsWith('.ts'));

  const offenders = [];
  for (const file of dataFiles) {
    const source = read(file);
    let index = source.indexOf('Promise.all(');
    while (index >= 0) {
      // Scan the argument list to its matching paren, then look for a `tx` receiver.
      let depth = 0;
      let end = index + 'Promise.all'.length;
      for (; end < source.length; end++) {
        const ch = source[end];
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      const args = source.slice(index, end);
      if (/(^|[^\w.])tx\s*\./.test(args)) {
        offenders.push(file.split('/').pop());
      }
      index = source.indexOf('Promise.all(', end);
    }
  }

  check(
    'Transaction concurrency',
    `no Promise.all over a transaction client (${dataFiles.length} files scanned)`,
    offenders.length === 0,
  );
  check(
    'Transaction concurrency',
    'the measured-parallel pool case is still permitted',
    read('src/server/portal/data.ts').includes('Promise.all('),
  );
}

/* ------------------------------------------------------------ Symptom triage */

/*
 * The emergency check must come FIRST, and the model must not be able to overturn it.
 *
 * This is the one rule in the feature that a refactor could invert without any test going
 * red at the type level: move the engine call above `detectRedFlag`, and a patient
 * describing a heart attack gets whatever a language model felt like saying. So the
 * ordering is asserted structurally, on the source.
 *
 * Also asserted: enabling the third-party engine is gated on an explicit BAA
 * acknowledgement. Symptom text is PHI, and OpenAI does not offer a BAA on the free tier —
 * so a key pasted in during a late-night experiment must fail to boot, not quietly start
 * shipping patients' symptoms to a vendor that trains on them.
 */
{
  const orchestrator = read('src/server/triage/index.ts');
  const redFlagIndex = orchestrator.indexOf('detectRedFlag(request.message)');
  const engineIndex = orchestrator.indexOf('getTriageEngine().assess');

  check(
    'Symptom triage',
    'the emergency check runs before the engine is consulted',
    redFlagIndex > 0 && engineIndex > 0 && redFlagIndex < engineIndex,
  );

  check(
    'Symptom triage',
    'a red flag returns without reaching the engine',
    /if\s*\(redFlag\)\s*\{[\s\S]{0,600}?return\s*\{/.test(orchestrator),
  );

  const envSource = read('src/env/server.ts');
  check(
    'Symptom triage',
    'the third-party engine requires an acknowledged BAA',
    envSource.includes('TRIAGE_THIRD_PARTY_BAA_ACKNOWLEDGED') &&
      envSource.includes("TRIAGE_ENGINE === 'openai'"),
  );
  check(
    'Symptom triage',
    'the local engine is the default (no PHI leaves by default)',
    envSource.includes("z.enum(['local', 'openai']).default('local')"),
  );

  /*
   * The vendor adapter must be reachable only through the gated factory. A direct
   * `new OpenAiTriageEngine` anywhere else would bypass the env check entirely.
   */
  const constructors = [];
  for (const dir of ['src/server', 'src/app', 'src/lib']) {
    const walk = (d) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = `${d}/${entry.name}`;
        if (entry.isDirectory()) walk(p);
        else if (
          /\.tsx?$/.test(entry.name) &&
          read(p).includes('new OpenAiTriageEngine(')
        ) {
          constructors.push(p);
        }
      }
    };
    walk(dir);
  }
  check(
    'Symptom triage',
    'the vendor adapter is constructed only by the gated factory',
    constructors.length === 1 && constructors[0] === 'src/server/triage/index.ts',
  );

  const triageData = read('src/server/portal/triage.ts');
  check(
    'Symptom triage',
    'every triage read and write is audited as the patient',
    triageData.includes('auditAsPatient') &&
      triageData.includes("action: 'triage.read'") &&
      triageData.includes("action: 'triage.message'"),
  );

  /*
   * Symptom text must never reach the audit log. The metadata this layer writes is
   * lengths, roles and codes; a `body` or `message` value in there would be a second copy
   * of the chart under six-year retention.
   */
  check(
    'Symptom triage',
    'no symptom text in audit metadata',
    !/metadata:\s*\{[^}]*(body|message|symptoms)\s*[,}]/.test(triageData),
  );
}

/* ------------------------------------------------------- Scheduled maintenance */

/*
 * A job that is not registered does not run.
 *
 * This is the precise shape of the bug the maintenance feature exists to fix:
 * `pruneAuthAttempts` was written, documented a 90-day retention, and was called from
 * nowhere — so the retention was never enforced and nothing said so. Writing a second job
 * and forgetting to register it would reproduce that exactly, and silently.
 */
{
  const jobs = read('src/server/maintenance/jobs.ts');
  const runner = read('src/server/maintenance/run.ts');

  const exported = [...jobs.matchAll(/export const (\w+): MaintenanceJob/g)].map(
    (m) => m[1],
  );
  const registryStart = jobs.indexOf('MAINTENANCE_JOBS: readonly MaintenanceJob[] = [');
  const registry = jobs.slice(registryStart, jobs.indexOf('];', registryStart));

  check(
    'Scheduled maintenance',
    `every exported job is registered (${exported.length} job(s))`,
    exported.length > 0 && exported.every((name) => registry.includes(name)),
  );

  /*
   * These jobs run daily holding the OWNER credential — the only code in the project that
   * does. A DELETE or a DROP reaching audit_event would be a six-year compliance record
   * disappearing on a schedule, so the file must contain neither.
   */
  check(
    'Scheduled maintenance',
    'no maintenance job deletes or drops audit data',
    !/delete\s+from\s+audit/i.test(jobs) && !/\bdrop\s+(table|partition)\b/i.test(jobs),
  );

  /*
   * The maintenance modules are loaded directly by `node` from scripts/maintenance.js,
   * which resolves neither the project's `@/` alias nor its extensionless imports. A
   * runtime import here would not fail a build or a test — it would fail at 3am in cron,
   * which is the worst place to discover it.
   */
  const runtimeImports = (source) =>
    [...source.matchAll(/^import\s+(?!type\b)/gm)].length;

  check(
    'Scheduled maintenance',
    'the job modules carry no runtime imports (they run under plain node)',
    runtimeImports(jobs) === 0 && runtimeImports(runner) === 0,
  );

  check(
    'Scheduled maintenance',
    'a failed job is recorded rather than only thrown',
    runner.includes("outcome = 'failed'") &&
      runner.includes('INSERT INTO maintenance_run'),
  );

  check(
    'Scheduled maintenance',
    'the run log is append-only for the application role',
    /REVOKE\s+UPDATE,\s*DELETE,\s*TRUNCATE\s+ON\s+"maintenance_run"\s+FROM\s+cliniqo_app/i.test(
      read('drizzle/0017_solid_quicksilver.sql'),
    ),
  );
}

/* ----------------------------------------------------------- Google sign-in */

/*
 * Two flows, two doors, and one CSP directive that silently breaks both.
 */
{
  const mw = read('src/middleware.ts');
  const staffStart = read('src/app/auth/google/start/route.ts');
  const staffCallback = read('src/app/auth/google/callback/route.ts');
  const portalStart = read('src/app/(portal)/portal/auth/google/start/route.ts');
  const portalCallback = read('src/app/(portal)/portal/auth/google/callback/route.ts');
  const staffModule = read('src/server/auth/google.ts');
  const portalModule = read('src/server/portal/google.ts');
  const envFile = read('src/env/server.ts');
  const portalLogin = read('src/app/(portal)/portal/login/page.tsx');

  /*
   * Read from the RAW source, anchored on the double quotes of the directive string.
   *
   * Not `stripComments`: its `//` line-comment rule also eats the `//` in
   * `https://accounts.google.com`, which silently truncates every directive it is asked
   * about — the comments above these directives quote `form-action` in backticks and
   * `'self'` in single quotes, so anchoring on `"` is what actually disambiguates them.
   */
  const directive = (name) => new RegExp(`"${name} ([^"]+)"`).exec(mw)?.[1] ?? '';
  const formAction = directive('form-action');

  /*
   * The bug this group was written for.
   *
   * Sign-in starts as a same-origin form POST that answers 303 to accounts.google.com,
   * and Chromium re-checks `form-action` against the REDIRECT TARGET — so `'self'` alone
   * blocks the navigation and reports the violation against the original same-origin URL.
   * Firefox does not re-check, so the flow looks fine there. Nothing fails at build,
   * lint or test time; the button simply does nothing in Chrome.
   */
  check(
    'Google sign-in',
    'the CSP permits the redirect to Google (Chromium re-checks form-action on redirect)',
    formAction.includes("'self'") && formAction.includes('https://accounts.google.com'),
  );

  /*
   * And ONLY there. `connect-src 'self'` is what bounds exfiltration on pages rendering
   * PHI, and this flow is server-side redirects plus one server-to-server POST — it needs
   * no Google origin in connect-src and no Google script at all. An entry in either is a
   * PHI egress path that arrived as a sign-in convenience.
   */
  check(
    'Google sign-in',
    'no Google origin reaches connect-src or script-src',
    !/google/i.test(directive('connect-src')) && !/google/i.test(directive('script-src')),
  );

  /*
   * The separation that keeps a patient's Google sign-in out of the staff door.
   *
   * If the two flows shared a handshake cookie, a portal sign-in could be completed at
   * the staff callback — which would then look up the patient's verified address in
   * `user_account` and, for anyone who is both, mint a staff session from a patient's
   * consent. Different cookie names are what make that unreachable rather than merely
   * unintended.
   */
  const staffCookie = /OAUTH_COOKIE = '([^']+)'/.exec(staffModule)?.[1];
  const portalCookie = /PORTAL_OAUTH_COOKIE = '([^']+)'/.exec(portalModule)?.[1];
  check(
    'Google sign-in',
    'the staff and patient handshakes use different cookies',
    Boolean(staffCookie) && Boolean(portalCookie) && staffCookie !== portalCookie,
  );

  /* Comments stripped: both files NAME the other table while explaining why they never
     read it, and the prose must not be what satisfies the check. */
  check(
    'Google sign-in',
    'neither callback can resolve the other audience',
    !/user_?[Aa]ccount/.test(
      stripComments(portalCallback) + stripComments(portalModule),
    ) && !/patient_?[Aa]ccount/.test(stripComments(staffCallback)),
  );

  /*
   * POST only, on both. A GET start route fires from any prefetch, link or <img> on any
   * page — and on the portal the redirect ITSELF is the disclosure being consented to, so
   * a drive-by GET would make the disclosure without anybody choosing it.
   */
  check(
    'Google sign-in',
    'both start routes are POST-only',
    !/export\s+async\s+function\s+GET/.test(staffStart) &&
      !/export\s+async\s+function\s+GET/.test(portalStart),
  );

  /*
   * Off unless the clinic says otherwise. Staff sign-in tells Google that an employee
   * authenticated somewhere; patient sign-in tells Google that an identified person
   * receives care at a named practice. Inheriting the second from the first would make
   * that disclosure a side effect of a configuration change.
   */
  check(
    'Google sign-in',
    'patient Google sign-in is off by default',
    /PORTAL_GOOGLE_SIGN_IN: booleanish\.default\(false\)/.test(envFile),
  );

  check(
    'Google sign-in',
    'a hosted-domain restriction cannot be applied to patients',
    /allowedHostedDomain: undefined/.test(stripComments(portalModule)) &&
      !/hostedDomain/.test(stripComments(portalCallback)),
  );

  /*
   * Links, never creates — on both sides. A sign-in that could create its own account
   * would let anyone with a Google address mint a login on a system holding patient
   * records; on the portal it would also answer "is this person a patient here?" by
   * succeeding for strangers.
   */
  check(
    'Google sign-in',
    'neither Google callback creates an account itself',
    !/insert\(userAccount\)/.test(staffCallback) &&
      !/insert\(patientAccount\)/.test(portalModule + portalCallback),
  );

  /*
   * An unverified address is a claim in a profile, and on the portal it resolves straight
   * to somebody's medical record.
   */
  check(
    'Google sign-in',
    'an unverified Google address is refused by both callbacks',
    /emailVerified/.test(staffCallback) && /emailVerified/.test(portalCallback),
  );

  /*
   * Withdrawing consent revokes the row; it never deletes it. The record that an
   * authorization was given and later taken back is the evidentiary part — a link that
   * vanishes leaves the clinic unable to show either.
   */
  check(
    'Google sign-in',
    'a withdrawn patient link is revoked, not deleted',
    /revokedAt: new Date\(\)/.test(portalModule) &&
      !/\.delete\(patientIdentity\)/.test(portalModule),
  );

  /*
   * The notice has to come BEFORE the button, because pressing the button is itself the
   * disclosure. Everything else in the feature — the recorded authorization, the audit
   * row, the disconnect control — is downstream of the patient having been told first.
   */
  /* The FORM that starts the flow, not the button's label: other copy on the page may
     mention Google, and a label match would let the notice slide below the real button. */
  const noticeAt = portalLogin.indexOf('tells Google that');
  const buttonAt = portalLogin.indexOf('action="/portal/auth/google/start"');
  check(
    'Google sign-in',
    'the portal states what Google learns before the button that tells it',
    noticeAt !== -1 && buttonAt !== -1 && noticeAt < buttonAt,
  );

  /*
   * A database outage must not leave the handshake behind.
   *
   * Both callbacks promise, in a comment on the helper that builds every response, that
   * the handshake is single-use WHATEVER the outcome. A throw skips that helper, so an
   * unreachable database left the cookie set and answered 500 -- observed, not theorised.
   * The catch is what makes the comment true, and this is what keeps the catch there.
   */
  for (const [name, source] of [
    ['staff', staffCallback],
    ['portal', portalCallback],
  ]) {
    check(
      'Google sign-in',
      `a database failure in the ${name} callback clears the handshake and logs only a code`,
      /} catch \(error\) \{\s*console\.error\([^;]*describeError\(error\)\);\s*return response\(UNAVAILABLE\);/.test(
        stripComments(source),
      ),
    );
  }

  /*
   * The portal SSO door reaches the same records as the password door, so it gets the
   * same limiter. An SSO path that skips rate limiting is simply the cheaper way in.
   */
  check(
    'Google sign-in',
    'the portal callback is rate limited like the password login',
    /checkIpRateLimit/.test(portalCallback) && /recordAttempt/.test(portalCallback),
  );
}

/* ------------------------------------------------------------ log exhaust */

/*
 * No error MESSAGE reaches a log line.
 *
 * Measured: Drizzle's `DrizzleQueryError` message is the SQL plus every bound parameter.
 * Four sites logged `error.message` from a failed audit insert, whose parameters include
 * `purpose` — the free text a clinician types to justify emergency access. A database blip
 * during a break-glass request would have written that justification into the application
 * log. `describeError` logs the class and code instead; this keeps it that way.
 */
{
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const code = stripComments(read(full));
        for (const m of code.matchAll(/console\.\w+\(([^;]*)\);/g)) {
          if (/\.message\b/.test(m[1])) offenders.push(full.replace(/^src\//, ''));
        }
      }
    }
  };
  walk('src');

  check(
    'Log exhaust',
    `no log line prints an error message${offenders.length ? ` (found in: ${[...new Set(offenders)].join(', ')})` : ''}`,
    offenders.length === 0,
  );
}

/* ---------------------------------------------------------- self-registration */

/*
 * People creating their own accounts. Every guarantee below is one a well-meant refactor
 * could quietly remove while every page still works.
 */
{
  const envFile = read('src/env/server.ts');
  const token = stripComments(read('src/lib/signed-token.ts'));
  const pending = stripComments(read('src/server/auth/pending-signup.ts'));
  const staffSignup = stripComments(read('src/server/auth/staff-signup.ts'));
  const patientSignup = stripComments(read('src/server/portal/signup.ts'));
  const signupActions = stripComments(read('src/server/actions/signup.ts'));
  const portalActions = stripComments(read('src/server/actions/portal.ts'));
  const patientSchemas = read('src/lib/patient-schemas.ts');
  const staffSchemas = read('src/lib/signup-schemas.ts');
  const staffData = stripComments(read('src/server/data-access/staff.ts'));

  check(
    'Self-registration',
    'both sign-up switches are off by default',
    /STAFF_SELF_SIGNUP: booleanish\.default\(false\)/.test(envFile) &&
      /PORTAL_SELF_SIGNUP: booleanish\.default\(false\)/.test(envFile),
  );

  /*
   * The whole reason staff self-registration is acceptable. A sign-up that could grant a
   * role would let anyone with a Google account choose their own access to patient records.
   */
  check(
    'Self-registration',
    'a self-registered staff account is created with no roles',
    /insert\(userAccount\)/.test(staffSignup) &&
      !/userRole|roleId|user_role/.test(staffSignup) &&
      !/roles/.test(staffSchemas.replace(/\/\*[\s\S]*?\*\//g, '')),
  );

  /*
   * Attaching a visitor to an existing chart because their name and birthday match is how
   * portals leak records. The sign-up may create a patient; it may never read one.
   */
  check(
    'Self-registration',
    'patient self-registration never looks up an existing patient',
    /insert\(patient\)/.test(patientSignup) && !/\.from\(patient\)/.test(patientSignup),
  );

  /*
   * The email and Google subject must come from the signed token, never from the form, or a
   * visitor could register an address they do not own. Both input schemas are strict and
   * carry no email field, and both actions read the token before creating anything.
   */
  const patientInput =
    /patientSelfSignupInput = z[\s\S]*?\.strict\(\)/.exec(patientSchemas)?.[0] ?? '';
  const staffInput =
    /staffSelfSignupInput = z[\s\S]*?\.strict\(\)/.exec(staffSchemas)?.[0] ?? '';
  const readsBeforeCreate = (source, create) => {
    const readAt = source.indexOf('readPendingSignup(');
    const createAt = source.indexOf(create);
    return readAt !== -1 && createAt !== -1 && readAt < createAt;
  };
  check(
    'Self-registration',
    'the sign-up identity comes from the signed token, never the form',
    patientInput.length > 0 &&
      staffInput.length > 0 &&
      !/email/.test(patientInput) &&
      !/email/.test(staffInput) &&
      readsBeforeCreate(signupActions, 'createSelfRegisteredStaff(') &&
      readsBeforeCreate(portalActions, 'createSelfRegisteredPatient('),
  );

  check(
    'Self-registration',
    'the pending sign-up token is HMAC-signed, compared in constant time, and expires',
    /createHmac\('sha256'/.test(token) &&
      /timingSafeEqual/.test(token) &&
      /exp <= nowMs/.test(token),
  );

  /* The same separation the two Google callbacks keep, one step later. */
  check(
    'Self-registration',
    'staff and patient sign-up tokens use different cookies and are checked for audience',
    /staff: 'cliniqo_signup'/.test(pending) &&
      /portal: 'cliniqo_portal_signup'/.test(pending) &&
      /payload\['aud'\] !== audience/.test(pending),
  );

  /* A spent token that survived a failed attempt could be replayed. */
  check(
    'Self-registration',
    'a pending sign-up token is cleared whether or not the sign-up succeeded',
    signupActions.indexOf("clearPendingSignup('staff')") <
      signupActions.indexOf('if (!result.ok)') &&
      portalActions.indexOf("clearPendingSignup('portal')") <
        portalActions.indexOf('if (!result.ok) redirect'),
  );

  /*
   * In production, staff sign-up must be limited to the clinic's Workspace, or anyone on the
   * internet can file a request that looks like a colleague's, one click from a role.
   */
  const production = envFile.slice(envFile.indexOf("env.APP_ENV !== 'production'"));
  check(
    'Self-registration',
    'staff self-registration requires a Workspace domain in production',
    /env\.STAFF_SELF_SIGNUP && !env\.GOOGLE_ALLOWED_HD/.test(production),
  );

  /* The staff layout calls this for every role; it must gate itself, as the break-glass badge does. */
  const badge =
    /export async function staffAccessRequestBadge[\s\S]*?\n}/.exec(staffData)?.[0] ?? '';
  check(
    'Self-registration',
    'the access-request badge checks staff.read before counting',
    badge.indexOf("can(permissions, 'staff.read')") !== -1 &&
      badge.indexOf("can(permissions, 'staff.read')") < badge.indexOf('getDb()'),
  );
}

/* ------------------------------------------- Request correlation (F12) */

/*
 * `audit_event.request_id` sat in the schema unpopulated for several phases, which is the
 * failure mode this block guards: a column that exists, reads as a feature, and is null in
 * every row. The three properties below are what make it evidence rather than decoration.
 */
{
  const logCode = stripComments(read('src/server/audit/log.ts'));

  check(
    'Request correlation (F12)',
    'middleware issues a request id per request',
    middlewareCode.includes('const requestId = crypto.randomUUID()') &&
      middlewareCode.includes("headers.set('x-request-id', requestId)"),
  );

  /*
   * The id is written into an append-only legal record. Honouring an inbound header would
   * let a caller stitch their reads onto someone else's id, or issue a fresh one per
   * request to defeat the grouping entirely.
   */
  check(
    'Request correlation (F12)',
    'the id is generated, never read from the inbound request',
    !middlewareCode.includes("get('x-request-id')"),
  );

  /*
   * Resolved inside the writer, not passed by callers. Twenty-six call sites across eleven
   * modules; one that forgets is one whose rows cannot be grouped, and nothing about the
   * row would look wrong.
   */
  check(
    'Request correlation (F12)',
    'every audit row resolves the id centrally, so no call site can forget',
    logCode.includes('requestId: input.requestId ?? (await currentRequestId())'),
  );

  check(
    'Request correlation (F12)',
    'a missing or malformed id yields null rather than failing the audit write',
    logCode.includes('REQUEST_ID_SHAPE.test(value)') &&
      /catch\s*{\s*return null;\s*}/.test(logCode),
  );
}

/* ------------------------------------------ Action trust levels (F16) */

/*
 * An unauthenticated action sitting among administrator-only ones is how the next action
 * gets written by copying a neighbour and inheriting a check that does not apply to it.
 * Each action still authorizes itself; this keeps the MODULE readable as one trust level.
 */
{
  const staffActions = stripComments(read('src/server/actions/staff.ts'));

  check(
    'Action trust levels (F16)',
    'the unauthenticated claim action does not live among the admin-only ones',
    !staffActions.includes('claimAccountAction') &&
      existsSync('src/server/actions/account-claim.ts'),
  );

  check(
    'Action trust levels (F16)',
    'the claim action still rate-limits and still validates',
    (() => {
      const claim = stripComments(read('src/server/actions/account-claim.ts'));
      return (
        claim.includes('checkIpRateLimit(ip)') &&
        claim.includes('claimInput.safeParse(formFields(formData))')
      );
    })(),
  );

  /*
   * The admin response type carries `setupToken`, which the claim flow must never return.
   * Separate types mean that is a compile error rather than a code-review catch.
   */
  check(
    'Action trust levels (F16)',
    'the claim response type cannot carry an admin-only setup token',
    !stripComments(read('src/server/actions/account-claim.ts')).includes('setupToken'),
  );
}

/* ------------------------------------------------ Patient merge (safety) */

/*
 * A merge moves clinical rows between records. Done wrong it combines two people's charts,
 * which is a breach; left undone, an allergy on one chart stays invisible on the other.
 * Both failure modes are silent, so the properties that prevent them are asserted here.
 */
{
  const merge = stripComments(read('src/server/data-access/patient-merge.ts'));
  const mergeMigration = read('drizzle/0022_patient_merge.sql');

  check(
    'Patient merge',
    'only admin may merge — not the front desk, not a clinician',
    permissionsForRoles(['admin']).has('patient.merge') &&
      !permissionsForRoles(['receptionist']).has('patient.merge') &&
      !permissionsForRoles(['doctor']).has('patient.merge'),
  );

  /*
   * The audit trail of a folded-away chart is what a §164.528 accounting for the old MRN
   * reads. Moving those rows would erase the answer — and the app role holds no UPDATE on
   * audit_event anyway, so a line that tried would fail at runtime instead of review.
   */
  check(
    'Patient merge',
    'audit rows and break-glass grants are never moved by a merge',
    !/key:\s*'audit_event'/.test(merge) && !/key:\s*'break_glass_grant'/.test(merge),
  );

  /*
   * Ordering, learned the hard way: the no-chains trigger fires BEFORE INSERT and reads
   * `patient.merged_into_patient_id`. Setting the pointer first means the transaction's
   * own update is what the trigger sees, and EVERY merge is refused as a chain. The whole
   * feature was inert until this order was corrected.
   */
  check(
    'Patient merge',
    'the merge record is inserted before the pointer is set',
    merge.indexOf('.insert(patientMerge)') > 0 &&
      merge.indexOf('.insert(patientMerge)') <
        merge.indexOf('mergedIntoPatientId: survivingPatientId'),
  );

  /* Chains are refused in the database, not only in the code that calls it. */
  check(
    'Patient merge',
    'no merge chains, enforced by a trigger',
    mergeMigration.includes('cliniqo_patient_merge_no_chains') &&
      mergeMigration.includes('BEFORE INSERT ON "patient_merge"'),
  );

  /*
   * Reversal moves back exactly what the manifest names. "Move back everything on the
   * survivor" would hand one person the other's rows — the failure this feature corrects,
   * performed in reverse.
   */
  check(
    'Patient merge',
    'reversal restores only the rows the manifest names',
    merge.includes('inArray(table.id, ids)'),
  );

  /* Both charts get an audit row, so neither accounting ends without an explanation. */
  check(
    'Patient merge',
    'the merge is audited against both charts',
    (merge.match(/action: 'patient\.merge'/g) ?? []).length >= 2,
  );

  /* A bearer credential must never be silently retargeted at a different chart. */
  check(
    'Patient merge',
    'outstanding portal invitations are revoked, never moved',
    merge.includes('patient_setup_token_revoked') &&
      !/patientSetupToken[\s\S]{0,200}set\(\{\s*patientId/.test(merge),
  );
}

/* --------------------------------------- Audited subject normalisation */

/*
 * Every `subjectFrom` in the data-access layer ends `?? ''`, because the row it reads may
 * be null. That empty string reaching PostgreSQL as a uuid raises `invalid input syntax`,
 * which turns a clean "not found" into a 500 AND loses the audit row for the attempt.
 * Normalised centrally; asserted here because the next `?? ''` will be written the same way.
 */
check(
  'Audit',
  'an unresolved audit subject becomes null, never an empty uuid',
  /subjectFrom\(result\)\s*\|\|\s*null/.test(stripComments(audited)),
);

/* ------------------------------------------ Activity review (F17) */

/*
 * 164.308(a)(1)(ii)(D) asks for the review; 164.316(b)(1) asks for it documented. The
 * failure mode is a review feature that exists and proves nothing: counts the reviewer
 * chose, or a record they can edit afterwards.
 */
{
  const review = stripComments(read('src/server/data-access/compliance-review.ts'));
  const reviewAction = stripComments(read('src/server/actions/compliance-review.ts'));
  const reviewMigration = read('drizzle/0023_audit_review.sql');

  check(
    'Activity review (F17)',
    'only admin may file a review',
    permissionsForRoles(['admin']).has('audit.review') &&
      !permissionsForRoles(['doctor']).has('audit.review') &&
      !permissionsForRoles(['receptionist']).has('audit.review'),
  );

  /*
   * THE security property. If the counts came from the form, whoever files the review
   * could report "nothing flagged" over a week that flagged fifty things — and that row
   * is the artifact an auditor is shown. `recordReview` takes no findings argument at all.
   */
  check(
    'Activity review (F17)',
    'the reviewer cannot supply the findings — the server recomputes them',
    /export async function recordReview\(\s*periodStart: Date,\s*periodEnd: Date,\s*notes: string,\s*\)/.test(
      review,
    ) &&
      review.includes('const digest = await buildReviewDigest(periodStart, periodEnd)') &&
      !reviewAction.includes('findings'),
  );

  /* An attestation that can be edited afterwards is not evidence of anything. */
  check(
    'Activity review (F17)',
    'a filed review cannot be edited or deleted by the application',
    /REVOKE UPDATE, DELETE, TRUNCATE ON "audit_review" FROM cliniqo_app/.test(
      reviewMigration,
    ),
  );

  /* A tick box is what this finding exists to avoid. */
  check(
    'Activity review (F17)',
    'a review must carry a written conclusion',
    /notes:[\s\S]{0,120}\.min\((\d+)/.test(reviewAction) &&
      Number(/notes:[\s\S]{0,120}\.min\((\d+)/.exec(reviewAction)?.[1] ?? 0) >= 10,
  );

  /* Reading the digest names patients, so it is a read of the log and audited as one. */
  check(
    'Activity review (F17)',
    'building the digest is gated on audit.read and audited',
    review.includes("permission: 'audit.read'") &&
      review.includes("action: 'audit.read'"),
  );

  /* The signal no permission check can produce, because every such read is authorized. */
  check(
    'Activity review (F17)',
    'the digest surfaces same-surname access',
    review.includes('sameSurname') && review.includes('string_to_array'),
  );
}

/* ------------------------------------------------- Second factor (TOTP) */

/*
 * Every other control in this system is written in terms of an authenticated actor, so a
 * stolen password is not one compromised control but all of them. These are the properties
 * that make the second factor worth having rather than worth bypassing.
 */
{
  const totp = stripComments(read('src/server/auth/totp.ts'));
  const mfa = stripComments(read('src/server/auth/mfa.ts'));
  const authAction = stripComments(read('src/server/actions/auth.ts'));
  const mfaAction = stripComments(read('src/server/actions/mfa.ts'));

  /*
   * THE bypass to prevent. If the password step created a session flagged "pending", every
   * getSession() in the codebase would become responsible for remembering the flag, and the
   * one that forgot would be a silent, complete bypass that reads like ordinary code.
   */
  check(
    'Second factor',
    'the password step creates no session when a factor is enrolled',
    /if \(await requiresSecondFactor\(account\.id\)\) \{[\s\S]{0,800}?redirect\('\/login\/verify'\)/.test(
      authAction,
    ) &&
      authAction.indexOf('requiresSecondFactor') <
        authAction.indexOf('createSession(tx, account.id'),
  );

  /* The session is created by the CHALLENGE, and the login is audited with it. */
  check(
    'Second factor',
    'the session is created only once the code verifies',
    mfaAction.includes('createSession(tx, pending.userId') &&
      mfaAction.indexOf('verifyChallenge(') < mfaAction.indexOf('createSession('),
  );

  /* A code valid for its whole window is replayable by anyone who watches it typed. */
  check(
    'Second factor',
    'a spent time-step cannot be used again',
    /if \(lastUsedStep !== null && step <= lastUsedStep\) continue;/.test(totp) &&
      mfa.includes('lastUsedStep: verdict.step'),
  );

  /* A secret in a database dump is a permanent second factor for everyone in it. */
  check(
    'Second factor',
    'the secret is encrypted at rest, with an authenticated cipher',
    totp.includes("createCipheriv('aes-256-gcm'") &&
      totp.includes('cipher.getAuthTag()') &&
      mfa.includes('sealSecret(secret, env.SESSION_SECRET)'),
  );

  /* Enabling on a button press locks people out with a mistyped secret or a wrong clock. */
  check(
    'Second factor',
    'enrollment is only switched on once a working code proves it',
    mfa.includes('confirmedAt: new Date()') &&
      /verifyCode\([\s\S]{0,120}?\)[\s\S]{0,200}?if \(!verdict\.ok\)/.test(mfa),
  );

  /* Recovery codes are compared, never read back — so there is nothing to gain from
     reversibility and a great deal to lose. */
  check(
    'Second factor',
    'recovery codes are hashed and single-use',
    totp.includes('hashRecoveryCode') &&
      !totp.includes('sealRecoveryCode') &&
      /isNull\(userRecoveryCode\.usedAt\)/.test(mfa),
  );

  /* Brute-forcing six digits is a million guesses: minutes with a botnet, unthrottled. */
  check(
    'Second factor',
    'the challenge is rate limited',
    mfaAction.includes('checkIpRateLimit(ip)'),
  );

  /* Who removed a factor, and whether it was their own, is the first thing an
     investigation asks after a compromise. */
  check(
    'Second factor',
    'removal records whether it was the account itself or an administrator',
    mfa.includes('bySelf: actorUserId === userId'),
  );

  /* An unattended signed-in screen is exactly what this protects against, so removing it
     from a live session must cost something. */
  check(
    'Second factor',
    'turning your own factor off re-checks the password',
    mfaAction.includes('verifyPassword(parsed.data.password'),
  );
}

/* --------------------------------------------------------------- report */

/*
 * Derived HERE, not earlier.
 *
 * It used to be computed further up, and every check block added below that point ran
 * and counted but never printed its name — three groups went silent that way. A report
 * that quietly omits a section is the same class of bug as a job that quietly never
 * runs, which is what half of these invariants exist to catch.
 */
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
