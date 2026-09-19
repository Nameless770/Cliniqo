# Cliniqo — Security Review

**Written at Phase 9. Re-checked 2026-09-15 — see "Where this stands now" before acting on
anything below.**

Audit only. No code changed.

Scope: the application as built through Phase 8, reviewed against HIPAA (United States)
and common web risk. Findings are ordered by what would hurt most, soonest.

Method: static inspection of every server action, data-access function, and route; a scan
of the built client bundle; and inspection of the generated SQL. Where a claim is
"verified", it was measured this session or in an earlier one against a live PostgreSQL —
that distinction is marked throughout, because several areas could **not** be re-verified
(see F15).

---

## Summary (as written, Phase 9)

| Severity | Count | Theme                                                                                            |
| -------- | ----- | ------------------------------------------------------------------------------------------------ |
| High     | 5     | Bulk-read exposure, CSP, and the entire infrastructure layer (encryption at rest, backups, BAAs) |
| Medium   | 10    | Missing patient-rights features, unwired break-glass, one validation gap, dead code              |
| Low      | 6     | Hygiene, process, and accepted risks                                                             |

**The single most important finding is F1.** Everything else is either infrastructure not
yet built, or a bounded defect.

---

## Where this stands now (2026-09-15)

Fourteen of the twenty-one findings are closed and one is partly closed; two were accepted
at the time and remain accepted. The original findings are kept below in full,
because the reasoning is why the current shape of the code is what it is — but **this table
is the current state**, and the text below it is history.

Re-checked by reading the code as it stands, not by trusting this document.

| #   | Phase 9 finding                              | Now                        | Where                                                                                                                                                                                                 |
| --- | -------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | No throttle on authenticated PHI reads       | **Closed**                 | `data-access/read-budget.ts`, enforced for every counted read in `audited.ts`; fails open on a count error, fails closed on the break-glass check; `bulkReaders()` feeds the dashboard                |
| F2  | CSP allows `'unsafe-inline'`                 | **Closed**                 | per-request nonce + `strict-dynamic` in `middleware.ts`; CI greps the built bundle to prove `'unsafe-eval'` is development-only                                                                       |
| F3  | Encryption at rest unconfigured              | **Open — infrastructure**  | nothing in the repository addresses it; still a go-live blocker                                                                                                                                       |
| F4  | No backups, no tested restore                | **Open — infrastructure**  | as above                                                                                                                                                                                              |
| F5  | No BAA inventory, hosting undecided          | **Open — decision**        | the discipline held: still no email, SMS, analytics or error-tracking dependency, and the one third-party engine is gated behind an explicit BAA acknowledgement                                      |
| F6  | `unarchivePatientAction` unvalidated         | **Closed**                 | validates like every sibling                                                                                                                                                                          |
| F7  | Dead duplicate audit reader                  | **Closed**                 | file deleted                                                                                                                                                                                          |
| F8  | No record export (§164.524)                  | **Closed**                 | `patients/[id]/export`                                                                                                                                                                                |
| F9  | No accounting of disclosures (§164.528)      | **Closed**                 | `patients/[id]/disclosures`, over `data-access/disclosures.ts`                                                                                                                                        |
| F10 | No retention policy or partition maintenance | **Partly closed**          | `server/maintenance/` + `scripts/maintenance.js` run on a schedule and are tested; the per-state retention period is still undetermined, so nothing is purged yet — which remains the correct default |
| F11 | Break-glass modelled but not wired           | **Closed**                 | request and review flow, and an active grant lifts the F1 ceiling                                                                                                                                     |
| F12 | No error boundary, no request correlation    | **Closed**                 | `(staff)/error.tsx`; `request_id` is now issued by middleware and stamped on every audit row by `writeAuditEvent` itself                                                                              |
| F13 | Patient ids in URLs                          | **Accepted**               | unchanged, and still the right call                                                                                                                                                                   |
| F14 | `booking_note` is a standing PHI leak        | **Accepted — operational** | unchanged; wants audit-review sampling, not schema                                                                                                                                                    |
| F15 | Phases 7–8 never verified against a database | **Closed as a process**    | CI now applies every migration to a clean PostgreSQL 17 and runs the database and end-to-end suites on every pull request                                                                             |
| F16 | `actions/staff.ts` mixes trust levels        | **Closed**                 | the unauthenticated claim action moved to `actions/account-claim.ts`, with its own response type that cannot carry a setup token                                                                      |
| F17 | Admin clinical reads need a review _process_ | **Closed**                 | `/audit/review` surfaces the patterns worth a look and records that somebody looked; a filed review cannot be edited by the application                                                               |
| F18 | No way to revoke another user's sessions     | **Closed**                 | `revokeAllSessionsForUser(..., 'admin_revoke')`, independent of deactivation                                                                                                                          |
| F19 | No breached-password check                   | **Open — decision**        | still an external call from a PHI system; deferred deliberately                                                                                                                                       |
| F20 | Dependency scanning not a CI gate            | **Closed**                 | `check:deps` runs in CI; production dependencies currently report zero advisories                                                                                                                     |
| F21 | No automated security regression tests       | **Closed, and then some**  | 169 static invariants plus a database and end-to-end suite, both gated in CI, with a check that the suite cannot silently shrink                                                                      |

### What is actually left

1. **F3, F4, F5 — the infrastructure block.** Unchanged since Phase 9 and still what gates
   go-live. There is no infrastructure-as-code in the repository at all, so there is
   nothing to review yet rather than something reviewed and found wanting.
2. **F19** — a decision, not a defect: a breached-password check is still an external call
   from a PHI system and needs a ruling rather than a patch.
3. **F10's retention period** — blocked on state law, as it has been since M11.

Nothing else outside the infrastructure block is open. F17 closed with the activity review;
what remains of it is not code but cadence — somebody has to open `/audit/review` weekly,
and the review history is what shows whether they did.

---

## Second pass — 2026-09-15

The four phases built after this review (self-registration, Google sign-in for staff and
patients, symptom triage, and the patient portal) had never been reviewed here. They were
read this session. **No new defect was found**, which is worth recording as a result rather
than an absence: each of the properties below was checked against the code, not assumed.

- **The third-party triage engine sends no identifier.** No name, MRN, date of birth,
  patient id or conversation id reaches the vendor — symptom text only. It is still a
  disclosure of PHI, which is why it is off by default and refuses to start without an
  acknowledged BAA.
- **The emergency check cannot be overridden by a model.** It runs first, deterministically,
  on the patient's raw words, and returns without consulting any engine.
- **The two Google flows cannot cross.** Different redirect URI, cookie, callback route and
  session table, with PKCE (S256), a constant-time `state` comparison, and a `nonce` bound
  per request. Neither callback creates an account.
- **Self-registered staff accounts hold no roles**, so every action refuses them until an
  administrator grants one.
- **The client boundary held through the newest UI.** The clinical client components take
  named view types (`AllergyView`, `FlagView`, one note version), never a record.

### N1 — The documentation has fallen behind the code

The only finding from this pass, and it is about this directory rather than the application.

`docs/02-data-model.md` documents the Phase 1 entities and does not mention
`user_identity`, `patient_account`, `patient_identity`, the triage tables, billing, or the
pending-signup token. `docs/04-project-structure.md` describes a `src/server/services/`
layer that no longer exists — actions call the data-access layer directly now. This
document, until today, reported eleven closed findings as open.

For most projects that is untidiness. Here the documentation is part of the control: the
argument that this system is safe to hold PHI is made in these files, and an auditor asking
"show me your data model" is owed the one that is running. Treat a doc update as part of
the work that changed the behaviour, the way the migration already is.

---

## HIGH

### F1 — No rate limiting on authenticated data paths

**Risk: bulk exfiltration by a compromised or malicious account.**

`checkIpRateLimit` is called by exactly two actions: login and account-claim. Verified:

```
rate limited:      auth.ts, staff.ts
NOT rate limited:  patients.ts, appointments.ts, notes.ts, prescriptions.ts
```

A signed-in account — stolen credentials, or a departing employee — can call
`searchPatients` or `getPatient` in a loop and read the entire patient roster at machine
speed. Nothing throttles it, and nothing alerts on it.

Every read _is_ audited, so the breach is reconstructable after the fact. That satisfies
§164.312(b) but not the point: the audit log tells you the scale of the breach you must
notify within 60 days. It does not stop it.

**What it needs:** a per-session read budget (e.g. N patient reads per minute), a bulk-read
alert on the audit stream, and a hard cap on search page size (already capped at 100).
Cheapest useful first step is the alert — a threshold on `patient.read` per actor per hour
surfaced on the dashboard beside `deniedLast24h`.

### F2 — CSP allows `'unsafe-inline'` for scripts

`next.config.ts` ships `script-src 'self' 'unsafe-inline'`, with a TODO that was never
closed. Inline script execution is the primary XSS payload channel, and this application
renders PHI into the DOM.

Impact is **bounded but real**: `connect-src 'self'` blocks exfiltration to an external
host, and the session cookie is `httpOnly` so it cannot be read by script. An attacker
would be limited to acting as the user within the app and reading what is on screen — which,
on a patient chart, is the whole record.

**What it needs:** a per-request nonce issued from middleware and threaded into Next's
inline bootstrap. This is the one CSP change worth the effort; the rest of the policy is
already tight (`frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`,
`form-action 'self'`).

### F3 — Encryption at rest is not configured or verified

§164.312(a)(2)(iv). TLS **in transit** is enforced and verified — `rejectUnauthorized: true`
in both the app pool and the migration runner, with `DATABASE_SSL=disable` rejected at
startup when `APP_ENV=production` (verified: the server refuses to boot).

At rest, there is nothing. The local Docker Compose volume is unencrypted, which is correct
for local development holding synthetic data, but no production storage decision has been
made. This is not a code defect; it is an unmade infrastructure decision that blocks
go-live.

### F4 — No backups, and therefore no tested restore

§164.308(a)(7) requires a contingency plan, and specifically a **tested** restore — a
backup job nobody has restored from is an assumption, not a control.

Nothing in the repository performs or schedules a backup. Note the coupling: a restore also
restores the audit log, so the restore target must carry the same two-role privilege
separation or the log becomes editable in the recovered environment.

### F5 — No BAA inventory, and hosting is undecided

Every vendor that touches PHI needs a signed Business Associate Agreement: hosting, managed
database, log aggregation, error tracking, backup storage. None are chosen.

The codebase has so far **avoided** creating BAA obligations deliberately — system fonts
instead of a font CDN, no email or SMS vendor, no error-tracking SDK, no analytics. That
discipline is worth preserving: adding Sentry or transactional email is a compliance
decision before it is a technical one.

---

## MEDIUM

### F6 — `unarchivePatientAction` does not validate its input

The only mutation without a zod schema. Verified:

```
patients.ts: 4 exported actions, 3 safeParse calls
  line 209:  const patientId = String(formData.get('patientId') ?? '');
```

Not injectable — Drizzle parameterises — but a malformed value reaches PostgreSQL as a
`uuid` parameter and raises `invalid input syntax for type uuid`, surfacing as an
unhandled 500 rather than a clean rejection. It also skips the shape check every sibling
action performs, which is the kind of inconsistency that becomes a real hole when the
function grows.

### F7 — Dead duplicate audit reader that does not self-log

`src/server/services/audit-read.ts` is unreferenced (verified: zero importers). It is the
Phase 3 implementation, superseded by `data-access/admin.ts`.

It matters because it is a _divergent_ second path: it queries `audit_event` directly and
carries a flag literally named `AUDIT_READ_IS_NOT_YET_SELF_LOGGED`. If a future developer
finds and wires it, audit reads stop being audited — silently, and in exactly the module
where that is least acceptable. Delete it.

### F8 — No patient record export (§164.524)

Patients have a right of access to their record, fulfilled within 30 days. There is no
export, so the obligation would be met by hand — which does not scale and is not auditable.

### F9 — No accounting-of-disclosures report (§164.528)

Patients may ask who accessed their record, going back six years. **The data exists and is
correctly shaped** — `audit_event.subject_patient_id` is indexed precisely for this — but
there is no report that produces it. This is a query and a page, not a redesign.

### F10 — No retention policy, no purge path, no partition maintenance

Three linked gaps:

- Retention beyond the HIPAA six-year documentation floor is governed by **state** medical
  record law and remains undetermined (open since the requirements analysis, M11).
- `cliniqo_create_audit_partition` exists but nothing calls it on a schedule. When the
  seeded 26-month window lapses, writes land in `audit_event_default`, which is a safety
  net that should always be empty. Nothing alerts on it.
- A patient who has ever been _accessed_ cannot be hard-deleted — the FK from
  `audit_event.subject_patient_id` blocks it (discovered empirically in Phase 4). Correct
  as a no-hard-delete guarantee, but it means a lawful purge has no path today.

### F11 — Break-glass is modelled but not wired

`break_glass_grant` exists, `breakglass.use` is granted to doctors, the review-queue index
exists, and the dashboard has a tile for it hardcoded to `0`. No flow issues a grant.

§164.312(a)(2)(ii) emergency access is **required**, not optional. Today the honest
position is that the schema anticipates it and the application does not implement it.

### F12 — No custom error boundary or request correlation

No `error.tsx` or `global-error.tsx`. Next masks server errors in production (generic
message plus a digest), so stack traces do not leak — but users get an unhelpful page and
have no reference to quote to support. `audit_event.request_id` exists and is never
populated.

### F13 — Patient identifiers appear in URLs and browser history

`/patients/<uuid>`, `/notes/<id>?patient=<uuid>`, `/audit?patient=<uuid>`.

A UUID is not among the 18 HIPAA identifiers and is not derived from patient data, but in
context it reveals that a given record exists at this clinic, and it persists in history on
shared front-desk machines. Mitigated by the global `Referrer-Policy: no-referrer`
(verified present) so it does not leak to third parties.

Recommendation: accept and document, rather than engineer around it. Opaque per-session
handles would complicate every link for a marginal gain.

### F14 — `appointment.booking_note` is a standing PHI leak into the front desk

By design, receptionists cannot see clinical data — enforced and measured (Phase 4: zero
clinical columns in their SQL). But they book appointments, and `booking_note` is free
text labelled "logistics only". Staff will eventually type "follow-up re: HIV meds" into
it.

The schema cannot prevent this. It is an operational control: label it clearly (done),
train, and sample it during audit review (not yet a process).

### F15 — Phases 7–8 were never verified against a database

Migrations **0009–0012 are unapplied**. Docker Desktop failed to start across the last two
sessions, so prescriptions, staff management, the setup-token flow, the filtered audit
viewer, and the dashboard have been verified statically and by build only.

Everything through Phase 6 _was_ verified live, including the exclusion constraint under
20-way concurrency, audit immutability, the receptionist field boundary at the SQL level,
and note version freezing. The later work has no equivalent evidence.

This is a finding, not an aside: **unapplied migrations are the most likely source of a
first-deploy failure**, and `0006`'s enum rename plus `0012`'s `ADD VALUE` are exactly the
kind of statement that behaves differently against a populated database.

---

## LOW

### F16 — `actions/staff.ts` mixes trust levels

Admin-only actions and the unauthenticated `claimAccountAction` share a file. Each checks
independently, so it is not a vulnerability — but a file mixing trust levels invites a
copy-paste that assumes the wrong one. Split before it grows.

### F17 — Administrator clinical read access needs a review _process_

Admin holds `patient.read.clinical` and `note.read` by design, audited. The control that
makes that acceptable is somebody actually reviewing those reads
(§164.308(a)(1)(ii)(D)). The viewer exists; the review cadence does not.

### F18 — No way to revoke another user's sessions without deactivating them

`revokeAllSessionsForUser` exists and is called on role change and deactivation. There is
no "sign this person out everywhere" control for a lost laptop.

### F19 — Password policy has no breach-list check

12-character minimum, no composition rules (correct — length beats composition). No check
against known-breached passwords. HIBP's k-anonymity API would not transmit the password,
but it is still an external call from a PHI system and needs a decision.

### F20 — Dependency scanning is not a CI gate

`npm audit` currently reports 4 moderate advisories, all in drizzle-kit's dev-only
`@esbuild-kit → esbuild` chain — accepted and documented, never in a runtime image. But
nothing fails the build on a _new_ advisory, and the one advisory that mattered
(drizzle-orm SQL injection, GHSA-gpj5-g38j-94v9) was caught by hand in Phase 1.

### F21 — No automated security regression tests

The strong invariants — receptionist sees no clinical SQL, audit is immutable, one booking
wins a race — were verified by ad-hoc scripts that were deleted afterwards. They should be
a test suite that runs in CI, or they will decay.

---

## Verified as sound (do not re-litigate)

Confirmed this session or earlier, against real artifacts:

- **No secrets in the client bundle.** Scanned `.next/static` for `DATABASE_URL`,
  `postgres://`, `SESSION_SECRET`, `password_hash`, `token_hash`, `scrypt$`, and
  credentials: **zero hits**. Also zero for `drizzle-orm`, `node:crypto`, `pg-pool`,
  `requirePermission`, `auditedRead` — no server module reached a client chunk.
- **No whole-record props into Client Components.** Every client boundary receives named
  fields. The only client component touching clinical text is `NoteEditor`, which is
  unavoidable for a textarea and is reached only behind `note.read`.
- **`clinicalNoteForProvider` never enters the schedule projection** — verified by
  inspection; reception sees `booking_note` only.
- **One HTTP route handler exists** (`/api/health`), unauthenticated by necessity and
  deliberately uninformative. Everything else is a server action.
- **Session handling**: `httpOnly`, `secure` outside local, `SameSite=Lax`, `__Host-`
  prefix in deployed environments, 15-minute idle and 12-hour absolute expiry both checked
  in the query, permissions resolved fresh per request, tokens stored as SHA-256.
- **Login timing is flat**: unknown email, unclaimed account, and wrong password all cost
  ~335 ms (measured); the decoy hash is warmed at startup.
- **Audit log is immutable** — privilege revoke _and_ trigger, blocking the schema owner
  too (measured).
- **No `console.log` anywhere**; the five `console.error/info` calls log messages and IDs,
  never record content. ESLint enforces this.
- **No error message reaches a client** from any server action.

---

## Recommended order of work

1. **F1** — bulk-read throttle and alert. Highest real-world risk, and it is application
   code you can write now.
2. **F15** — get a database up and apply 0009–0012. Everything else is guesswork until the
   last two phases are verified.
3. **F6, F7** — two small, unambiguous fixes.
4. **F3, F4, F5** — the infrastructure block. These gate go-live and are Phase 10 work.
5. **F2** — CSP nonce.
6. **F11, F8, F9** — the compliance features with statutory deadlines behind them.
7. **F21, F20** — turn the invariants into tests before they decay.

Nothing here requires redesign. The architecture held: the audited data-access layer, the
permission matrix, and the database-level guarantees all did their jobs, and two of the
findings above (F6, F7) were found precisely because the structure made the exceptions
visible.

---

## Third pass — 2026-09-19 — symptom triage

The second pass recorded that the emergency check "cannot be overridden by a model" and
found no new defect. That claim was true and also insufficient: nothing overrode the
check, but the check itself missed emergencies, and the result it produced could be
discarded one message later. Both were found by probing the detector with plain phrasings
rather than by reading it — the code reads correctly, which is why two passes of reading
had not caught either.

**F22 — negation was scoped to a window of words, not to a clause.** `negatedAt` scanned
the three words before a match for any negator and suppressed the red flag if it found
one. So a patient listing what they did not have before what they did — "I have no
appetite and chest pain", "I have no energy, chest pain too" — received no emergency
instruction at all. Describing symptoms by contrast is ordinary phrasing, not an edge
case. Negation is now scoped to its own clause: walking back from the match, the first
word that is not a modifier decides, and a conjunction or a noun means the negation
belonged elsewhere and the flag fires. Fixed.

**F23 — an emergency could be withdrawn by the next message.** `assessSymptoms` assessed
only the newest message, and the portal wrote its result over the conversation's `urgency`
unconditionally. A patient who wrote "my chest hurts", was told to call an ambulance, and
then added "my knee has been sore too" was answered _"a routine appointment is fine"_ —
and the denormalised urgency the front desk books from, without reading the symptom text,
was overwritten from `emergency` to `routine`. An emergency is now a property of the
conversation: raised by the current message, by any message still in the history window,
or by a flag standing on the row, and the stored urgency can rise but never fall. Fixed.

**F24 — the detector missed common wordings.** Six plain phrasings produced nothing,
including "I have trouble breathing" — the exact words of the instruction the module
itself displays. Also missed: "my chest is tight", "I think I am having a stroke", "I
cannot feel my left side", "I want to end it all", "I have taken too many pills". Added,
with a test that names each one. Fixed.

The general lesson is narrower than "test more". All three defects were invisible to
reading and obvious to probing, because each one is a gap between what the code says and
what a person would type. A safety list written in patients' words has to be checked
against patients' words.

`red_flag_code` on `triage_conversation` (migration 0026) is the durable half of F23: the
engine is only ever shown ten turns, so a flag raised on turn one cannot be re-derived on
turn twelve. It is set once and never cleared — only a clinician closing the conversation
ends it. An unrecognised code, including the `legacy` value the migration backfills onto
conversations that predate the column, still resolves to an emergency instruction rather
than to silence.
