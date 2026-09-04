# Cliniqo — Project Context

Keep this in mind for every response.

Cliniqo is a production-quality clinic management web app. It handles **protected health
information (PHI)** under **HIPAA (United States)**. Treat every design decision as if it
will be audited.

---

## Stack — do not substitute without asking

| Layer     | Choice                                  |
| --------- | --------------------------------------- |
| Framework | Next.js (App Router) + TypeScript        |
| Database  | PostgreSQL                               |
| ORM       | Drizzle ORM, with explicit SQL migrations |

If a task seems to need another library, ask before adding it. Any dependency that can
touch PHI (logging, email, SMS, error tracking, analytics, file storage) needs a Business
Associate Agreement with the vendor — flag it instead of installing it.

---

## Hard rules

1. **Server-side only.** All patient-data access happens on the server. Never ship patient
   data into the client bundle — no PHI in props passed to Client Components, no PHI in
   `localStorage`, no PHI in URL paths or query strings.
2. **Role-based access, enforced server-side, on every data operation.** Roles: `admin`,
   `doctor`, `receptionist`. Hiding a button is not access control. Every server action
   re-checks authorization itself; it never trusts that the caller already checked.
3. **Audit-log every read and write of a patient record.** Reads too, not just writes —
   HIPAA §164.312(b) requires recording who *looked*.
4. **No hard deletes of clinical data.** Soft-delete / archive. Same for edits: patients
   have a right to amend records (§164.526), so amendments preserve prior versions rather
   than overwriting them.
5. **Always generate the Drizzle migration alongside any schema change.** Explicit SQL,
   checked in, never auto-pushed.
6. **Prefer server actions over API routes** unless there's a clear reason (webhooks,
   third-party callbacks, streaming, non-browser clients).
7. **Explain any security-relevant decision you make.** A sentence on *why*, in the
   response — not just in a comment.

---

## What HIPAA means concretely here

- **Minimum necessary (§164.502(b)).** A role gets the narrowest slice of PHI that lets it
  do its job. This is why `receptionist` is scoped away from clinical notes below.
- **Unique user identification (§164.312(a)(2)(i)).** One account per human. No shared
  logins, no generic "front desk" account.
- **Automatic logoff (§164.312(a)(2)(iii)).** Sessions expire on inactivity.
- **Audit log retention: 6 years (§164.316(b)(2)(i)).** Audit rows are append-only and are
  never soft-deleted, purged, or edited — not even by `admin`.
- **Encryption in transit and at rest.** Treated as required, not optional.
- **No PHI in exhaust.** Not in application logs, stack traces, error messages shown to
  users, URLs, analytics events, or third-party telemetry. Log record *IDs*, never names,
  diagnoses, or note bodies.
- **Breach notification is 60 days.** Which is why the audit log has to be good enough to
  answer "whose data was accessed, by whom, when" without guesswork.

---

## Roles

| Capability                        | admin | doctor | receptionist |
| --------------------------------- | :---: | :----: | :----------: |
| Patient demographics / contact     |  ✅   |   ✅   |      ✅      |
| Scheduling & appointments          |  ✅   |   ✅   |      ✅      |
| Clinical notes, diagnoses, results |  ✅*  |   ✅   |      ❌      |
| Prescriptions                      |  ❌   |   ✅   |      ❌      |
| Billing                            |  ✅   |   ❌   |      ✅      |
| User & role management             |  ✅   |   ❌   |      ❌      |
| Read the audit log                 |  ✅   |   ❌   |      ❌      |

\* `admin` is an operational role, not a clinical one. Its access to clinical content is
itself audit-logged and should be justified — an office manager browsing charts is exactly
the pattern audits look for. If you're unsure whether `admin` should see something
clinical, ask rather than assuming yes.

Doctors are scoped to their own patients unless a break-glass path is used; break-glass
access is allowed but is logged loudly and flagged for review.

---

## How to build a feature

When asked for a feature, build a **full vertical slice, in this order**:

1. **Schema** — Drizzle table definitions.
2. **Migration** — explicit SQL, generated alongside the schema change.
3. **Server action(s)** — with the authorization check as the first thing in the function
   body, and the audit-log write in the same transaction as the data operation.
4. **UI** — Server Components by default; Client Components only where interactivity
   demands it, and never handed raw PHI it doesn't render.
5. **Access-control checks** — stated explicitly: which role, checked where, what happens
   on failure (deny by default).

Don't skip ahead to the UI. If a step doesn't apply, say so rather than silently omitting it.

---

## Not yet decided — ask before assuming

- Auth provider / session strategy
- Hosting and where the database lives (must be a BAA-covered vendor)
- Multi-tenancy: one clinic or many?
- Whether appointments need to sync to external calendars (an integration that would carry PHI)
