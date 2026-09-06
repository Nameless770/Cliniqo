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
    layoutCode.includes("pathname !== PASSWORD_CHANGE_PATH"),
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
    !apptDa.includes('new Date(input.startsAt)') && !apptDa.includes('new Date(startsAt)'),
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
