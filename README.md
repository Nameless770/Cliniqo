# Cliniqo

A clinic management application: appointments, patient records, clinical notes,
prescriptions, billing, and a patient portal.

It handles **protected health information (PHI)** and is built to **HIPAA (United States)**
rules. That decides most of what is unusual about this codebase: every read and write of a
patient record is audited, nothing clinical is ever hard-deleted, patient data never
reaches the browser bundle, and every server action re-checks permissions itself rather
than trusting the page that called it.

**Status: in development.** It has never held real patient data, and it must not until the
open decisions at the bottom of this file are settled.

|              |                                                                               |
| ------------ | ----------------------------------------------------------------------------- |
| Framework    | Next.js 16 (App Router), React 19, TypeScript in strict mode                  |
| Database     | PostgreSQL 17, Drizzle ORM, explicit SQL migrations                           |
| Styling      | Plain CSS — CSS Modules, design tokens, no UI framework                       |
| Runtime deps | `next`, `react`, `drizzle-orm`, `pg`, `zod`, `server-only` — and nothing else |

The dependency list is short on purpose. Anything that can touch PHI (logging, email, SMS,
error tracking, analytics, file storage) needs a Business Associate Agreement with the
vendor, so a package is a legal decision here as much as a technical one.

---

## Quick start

You need **Node 22 or newer** and **Docker Desktop** (for PostgreSQL).

```bash
npm install
cp .env.example .env          # then edit it — see the two lines below
docker compose up -d          # PostgreSQL 17, on 127.0.0.1:5432 only
node ./scripts/wait-for-db.js # the container answers a little after it starts
npm run db:setup              # applies every migration
npm run db:seed               # one clinic, one administrator, synthetic data
npm run dev
```

In `.env`, set two things before seeding:

- `SESSION_SECRET` — 32 or more random characters.
- `ALLOW_SEED_DATA=true` — seeding refuses to run without it, and the application refuses
  to start with it in production. Invented patients belong in development and nowhere
  else.

`npm run db:seed` prints an administrator email and a random password **once**. It is not
stored anywhere else, and the account must change it at first sign-in.

- Staff sign in at <http://localhost:3000/login>
- Patients sign in at <http://localhost:3000/portal/login>

If the database ever gets into a strange state, `npm run db:reset` throws the container
away and rebuilds it from the migrations.

### After pulling changes

Migrations do not apply themselves. When someone adds one, run:

```bash
npm run db:migrate
```

---

## What is in it

**Staff**

- Dashboard, schedule, and appointment booking with double-booking protection
- Patient records: search, register, amend (amendments keep the previous version, §164.526)
- Clinical notes, signing, and addenda; prescriptions; billing
- Audit log, a weekly review, and a break-glass path for emergency access to a record
  outside a clinician's own patients — logged loudly and flagged for review
- Staff and role administration, and an optional second factor (TOTP) per account

**Patients (portal)**

- Their own appointments: book, reschedule, cancel
- Their visit notes, which is the right of access (§164.524); a clinician can withhold a
  note where release would cause harm, and the patient is told that it exists
- A symptom assistant that suggests which service to book (see below)

**Sign-in**

- Email and password, with rate limiting and lockout
- Google, for staff and for patients, each with its own callback and handshake cookie
- Optional self-registration, off by default — see the switches in `.env.example`

---

## The symptom assistant

A patient describes a symptom and is pointed at the right clinic service. It never
diagnoses and never names a medicine.

**The emergency check runs first, always.** Chest pain, stroke signs, trouble breathing,
self-harm and the rest are matched by a hardcoded, deterministic list before any engine is
consulted, and nothing can overturn that answer. Once a conversation has raised an
emergency, it stays one.

Three engines, chosen by `TRIAGE_ENGINE`:

| Value             | What it does                                                                                      | PHI leaves the server?              |
| ----------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `local` (default) | In-process rules. Holds a short conversation, asks how long and how bad, then suggests a service. | No                                  |
| `model`           | Any server speaking the OpenAI chat-completions protocol, including one on this machine.          | Only if the URL is not this machine |
| `openai`          | OpenAI's API.                                                                                     | Yes — needs a BAA                   |

### Running a free model locally

A model on the same machine costs nothing, needs no account, and discloses nothing to
anybody — so no BAA is required.

1. Install [Ollama](https://ollama.com/download).
2. `ollama pull llama3.2:3b`
3. In `.env`:

```bash
TRIAGE_ENGINE=model
TRIAGE_MODEL_URL=http://localhost:11434/v1/chat/completions
TRIAGE_MODEL_NAME=llama3.2:3b
```

Whatever the model is, the application keeps the decisions:

- **The model never chooses the service or the urgency.** Those come from the rules, so the
  front desk cannot be told to book something the clinic does not offer.
- **Every reply is checked before a patient sees it.** A reply naming a medicine, a dose or
  a diagnosis, claiming a clinician has read the conversation, or inventing the clinic's
  opening hours is thrown away, and the built-in engine answers that turn instead.
- **If the model is off or slow, the built-in engine answers.** Nobody who is unwell gets an
  error page.
- Only the symptom text is sent. No name, no MRN, no date of birth, no identifiers.

Pointing `TRIAGE_MODEL_URL` at any host that is not this machine is a disclosure of PHI,
and the application refuses to start unless `TRIAGE_THIRD_PARTY_BAA_ACKNOWLEDGED=true`.
A free tier is not an exception to that: free is usually paid for with the data.

---

## Checks and tests

```bash
npm test              # unit, integration and end-to-end, against a real database
npm run verify        # typecheck, lint, security invariants, dependency audit, migration check
npm run check:security   # the structural invariants, on their own
npm run check:contrast   # WCAG AA contrast of the design tokens
```

Four layers, each covering what the one below cannot:

1. **Security invariants** (`scripts/security-invariants.mjs`) — structural rules read off
   the source: the emergency check runs before any model, a password sign-up creates no
   session, symptom text never reaches the audit log, and so on. They catch the refactor
   that quietly removes a guard while every other test stays green.
2. **Integration tests** — the real audited data layer against a real PostgreSQL, with a
   synthetic session. Permissions, audit rows, transactions, soft deletes.
3. **End-to-end journeys** — a real production build of the app, driven the way a person
   uses it, with **JavaScript off**. So each journey also proves the application works
   without scripting.
4. **The permission matrix check** (`npm run check:permissions`) — the roles in the code
   compared against the table in `CLAUDE.md`.

The test database is rebuilt from the checked-in migrations on every run, so the migrations
themselves are exercised constantly. All test data is synthetic (§164.514); a copy of
production is never a fixture.

When you add a check that is meant to prevent something, **break the thing on purpose and
watch it fail**, then restore it. A check that has never failed has never been tested.

---

## Layout

```
src/
  app/            Routes. (staff), (portal) and (auth) are route groups, not URL segments.
  components/     Shared UI. Server Components by default.
  db/             Drizzle schema and client.
  env/            Environment parsing. Refuses to start on an unsafe configuration.
  lib/            Pure helpers: permissions, schemas, formatting.
  server/         Everything that touches data: actions, audited data access, auth, triage.
drizzle/          Migrations, in order, checked in. Never auto-pushed.
scripts/          Database, seeding, maintenance and the invariant checker.
tests/            integration/ and e2e/, plus their helpers.
docs/             Requirements, data model, database operations, audit logging, security review.
```

---

## House rules

`CLAUDE.md` holds the full set; the short version:

1. **Server-side only.** No PHI in client props, in `localStorage`, or in a URL.
2. **Authorization on every data operation**, re-checked server-side. Hiding a button is
   not access control.
3. **Audit every read and write** of a patient record — reads too (§164.312(b)).
4. **No hard deletes** of clinical data. Amendments keep the prior version.
5. **Every schema change ships with its migration**, as explicit SQL.
6. **Server actions over API routes**, unless there is a real reason (webhooks, callbacks).
7. **No PHI in exhaust** — not in logs, stack traces, error messages, URLs or telemetry.
   Log record IDs, never names, diagnoses or note bodies.

Features are built as a full vertical slice, in this order: schema → migration → server
action (authorization first, audit in the same transaction) → UI → a statement of who may
do it and what happens when they may not.

---

## Not decided yet

These are deliberately open, and each one needs an answer before this holds real data:

- **Hosting, and where the database lives.** It must be a vendor with a signed BAA.
- **Multi-tenancy.** The schema carries `clinic_id` throughout, but whether one deployment
  serves several clinics is not settled.
- **Email and SMS.** There is no mail vendor, which is why account sign-up cannot confirm
  an address and setup links are handed over in person. Any vendor here needs a BAA.
- **Calendar sync.** An integration that would carry PHI to a third party.

Audit rows are kept for six years (§164.316(b)(2)(i)), are append-only, and are never
edited or purged — not even by an administrator.
