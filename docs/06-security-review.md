# Cliniqo — Security Review (Phase 9)

Audit only. No code changed.

Scope: the application as built through Phase 8, reviewed against HIPAA (United States)
and common web risk. Findings are ordered by what would hurt most, soonest.

Method: static inspection of every server action, data-access function, and route; a scan
of the built client bundle; and inspection of the generated SQL. Where a claim is
"verified", it was measured this session or in an earlier one against a live PostgreSQL —
that distinction is marked throughout, because several areas could **not** be re-verified
(see F15).

---

## Summary

| Severity | Count | Theme |
| -------- | ----- | ----- |
| High | 5 | Bulk-read exposure, CSP, and the entire infrastructure layer (encryption at rest, backups, BAAs) |
| Medium | 10 | Missing patient-rights features, unwired break-glass, one validation gap, dead code |
| Low | 6 | Hygiene, process, and accepted risks |

**The single most important finding is F1.** Everything else is either infrastructure not
yet built, or a bounded defect.

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

Every read *is* audited, so the breach is reconstructable after the fact. That satisfies
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

It matters because it is a *divergent* second path: it queries `audit_event` directly and
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
- A patient who has ever been *accessed* cannot be hard-deleted — the FK from
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

Everything through Phase 6 *was* verified live, including the exclusion constraint under
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

### F17 — Administrator clinical read access needs a review *process*
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
nothing fails the build on a *new* advisory, and the one advisory that mattered
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
- **Audit log is immutable** — privilege revoke *and* trigger, blocking the schema owner
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
