# Cliniqo — Requirements Analysis (Phase 1)

No code. This document is the input to the data model and the build plan.

Scope as approved: staff-only MVP (administrator, doctor, receptionist), patients do not
log in. HIPAA (United States). Stack locked to Next.js App Router + TypeScript +
PostgreSQL + Drizzle.

---

## 1. Analysis of the requirements

The feature list is coherent and unusually well-scoped for a first pass. Three things
about its shape are worth naming before anything else.

**Staff-only is the right call and it removes a lot of risk.** No patient login means no
patient identity-proofing, no patient consent UI, no password resets for people you can't
verify, and no appointment reminders over SMS/email — which would put PHI into a channel
requiring its own BAA and its own breach surface. Every one of those is a project in
itself. Keep them out.

**Three roles is fewer than a real clinic has.** Real clinics also have nurses/medical
assistants (who chart but don't prescribe), billing clerks, and a practice manager. The
MVP doesn't need them, but the _model_ should not hardcode three roles into `if`
statements — otherwise adding "nurse" later means re-auditing every access check. Model
roles as data, and check permissions rather than role names.

**The requirement list is a permissions specification in disguise.** Almost every line
("view patient contact info, NOT clinical notes") is really a statement about who may see
which _fields_. Row-level access control is therefore not enough — Cliniqo needs
field-level scoping, and that boundary needs to live in one place rather than being
re-derived on each screen.

### Contradictions with the approved context

Two conflicts between this feature list and `CLAUDE.md`. Both need a ruling.

1. **Doctor patient scope.** `CLAUDE.md` says doctors are scoped to their own patients
   with a break-glass path. This list says doctors "view patient list and full patient
   records" — i.e. all patients. In a single small clinic, all-patients is normal and
   defensible. Pick one; it changes every clinical query.
2. **Billing.** The `CLAUDE.md` role matrix grants billing to admin and receptionist, but
   no billing feature appears anywhere in this list. Recommendation: drop billing from the
   MVP entirely and remove the row from the matrix. Billing pulls in payers, claims,
   coding, and an entire second compliance surface.

---

## 2. Missing or ambiguous requirements

Ordered roughly by how much damage the ambiguity does if left unresolved.

### Blocking — answer before the data model

**M1. What does "create prescriptions" actually mean?**
There are two wildly different products hiding behind that line:

- _Record and print._ The prescription is stored in the chart and printed or handed to the
  patient. Modest scope.
- _Electronically transmit to a pharmacy._ Requires the NCPDP SCRIPT standard, membership
  in a network such as Surescripts, and pharmacy directory integration. For controlled
  substances it additionally requires DEA EPCS compliance: third-party identity proofing of
  every prescriber, hard two-factor at signing time, and audited software.

Recommendation: **record-and-print only for the MVP, with controlled substances explicitly
out of scope** and enforced in the model (a flag on the medication record that blocks
prescribing). Deferring this is cheap. Discovering it late is not.

**M2. One clinic or many?**
Still unresolved from Phase 0. Multi-tenancy is not a feature you add later — it is a
`clinic_id` on nearly every table plus a tenancy check in every query, and retrofitting it
is exactly where cross-tenant PHI leaks come from. Recommendation: even for a single
clinic, include the `Clinic` entity and carry the foreign key, but build no tenant
switching UI. Cheap now, near-impossible later.

**M3. How is a patient uniquely identified?**
Two patients can share a name and a birth date. Without a medical record number (MRN),
staff will create duplicates — and duplicate charts are a genuine patient-safety issue: an
allergy recorded on chart A is invisible on chart B. Needs a clinic-issued MRN, a
deliberate duplicate-check step at registration, and eventually a merge flow. Merge itself
can wait until after the MVP, but the model must not make it impossible.

**M4. What is "clinic configuration"?**
Undefined in the requirements. At minimum it has to cover clinic timezone, operating hours
per weekday, holidays and closures, appointment types with default durations, and
per-provider working hours. Scheduling cannot be designed without these.

**M5. Can a doctor edit a note after signing it?**
"Versioned, not overwritten" is stated, but the clinical concept it maps to is _drafting_
versus _signing_. Before signing, a note is a working draft. After signing it becomes part
of the legal record, and corrections are **addenda**, not edits — the original stays
visible. Recommendation: adopt draft / signed / addended explicitly. This is also what
HIPAA §164.526 (right to amend) expects.

### Important — answer before the relevant phase

**M6. Timezone and DST.** Store instants in UTC, store the clinic's IANA timezone, render
in clinic-local time. Appointments booked across a DST boundary are a classic source of
off-by-one-hour bugs and missed appointments.

**M7. Attachments.** Lab results, imaging, scanned IDs, insurance cards. Not in the list,
but every clinic needs them within months. File storage is a separate PHI surface with its
own BAA, encryption, and access-control story. Defer the feature; leave room for it.

**M8. Allergies — structured or free text?** Free text is fast to build and useless for
safety checks. Coded allergies enable interaction warnings, which is a different and more
heavily regulated class of product. Recommendation: structured allergy records with a
free-text reaction field, but **no drug-interaction checking in the MVP** — a
half-working interaction checker is more dangerous than none, because clinicians start
trusting it.

**M9. Appointment reason is a PHI leak into the receptionist's view.** Receptionists are
correctly blocked from clinical notes — but they book appointments, and a free-text reason
field will fill up with "follow-up re: HIV meds". That is clinical data sitting in the
front-desk view, defeating the minimum-necessary boundary you just drew. Recommendation:
reason becomes a coded appointment _type_ chosen from a list, with any free-text detail
visible to clinicians only.

**M10. Password reset and account recovery.** Not specified. This is the softest part of
most auth systems, and there is PHI behind it. Recommendation for the MVP: **no
self-service reset.** An administrator issues a one-time reset. It is a small clinic, the
operational burden is trivial, and the attack surface drops to near zero.

**M11. Data retention.** HIPAA sets 6 years for _documentation_, but medical record
retention is set by **state** law and is typically 7–10 years for adults — and for minors,
often until some years past the age of majority. Cliniqo needs a per-state retention policy
before anything can ever be purged. Until that exists: archive, never purge.

**M12. Can a user hold more than one role?** In small clinics the owner is frequently both
administrator and physician. If roles are single-valued, that person needs two accounts —
which collides directly with the unique-user-identification rule. Recommendation: allow
multiple roles per user.

**M13. Who reviews the audit log, and when?** HIPAA §164.308(a)(1)(ii)(D) requires regular
review of system activity. A log nobody reads satisfies the letter and misses the point.
Needs at minimum a filterable viewer plus flagging of the patterns that actually matter:
break-glass use, an employee accessing a record that shares their own surname, bulk exports.

**M14. Preferred name, legal name, and gender.** Legal name is needed for records and
insurance; preferred name and pronouns matter for how staff address the patient. Sex
assigned at birth is clinically relevant to some care and is distinct from gender identity.
Model these as separate fields from the start — bolting them on later means backfilling a
sensitive field across every existing chart.

**M15. Notice of Privacy Practices acknowledgment.** Clinics must make a good-faith effort
to obtain written acknowledgment. It is a date and a document reference on the patient
record — trivial to include now, annoying to backfill.

---

## 3. Edge cases

### Scheduling

- **Concurrent double-booking.** Two receptionists booking the same provider and slot at
  the same moment. An application-level "is this slot free?" check _cannot_ prevent this —
  both requests read "free" before either writes. It must be enforced by the **database**,
  via a PostgreSQL exclusion constraint over a time range (`btree_gist`, roughly
  `EXCLUDE USING gist (provider_id WITH =, during WITH &&)`). Design the appointment table
  with a range column so this is available.
- Deliberate overbooking. Some clinics double-book on purpose. If so, the constraint needs
  a documented override path rather than being absent entirely.
- Booking outside operating hours, on a holiday, or during a provider's time off.
- Rescheduling into the past.
- An appointment spanning a DST transition — its wall-clock duration changes.
- Cancelling an appointment that has already been checked in, or that already has a note.
- Deactivating a staff member who has future appointments — those bookings are now
  orphaned and someone has to be told.
- Walk-in patients with no appointment; check-in must not require a prior booking.
- Booking for a patient who has since been archived.
- No-shows as a state distinct from cancellations — they are clinically and operationally
  different, and conflating them destroys the only signal you have about attendance.

### Concurrent edits

- Two clinicians open the same draft note; both save. Naive last-write-wins silently
  destroys one author's work. Needs optimistic concurrency — a version token checked on
  write, with the conflict surfaced explicitly to the user rather than resolved silently.
- A receptionist edits demographics while a doctor is reading the chart.
- Signing a note while someone else has it open for editing.

### Permission boundaries

- **Role change or deactivation mid-session.** If authorization is baked into a session
  token at login, a fired employee keeps their access until that token expires.
  Permissions must be resolved against current state on every request, and deactivation
  must terminate live sessions immediately.
- A user holding both admin and doctor roles — which permission set applies where.
- Break-glass access: allowed, logged loudly, reviewed. Note this is not merely permitted,
  it is **required** by §164.312(a)(2)(ii) (emergency access procedure).
- An employee accessing the chart of a relative, or their own. This is the single most
  common real-world HIPAA violation and it is invisible to permission checks — only audit
  review catches it.
- Error messages that leak existence. "No such patient" versus "access denied" tells an
  unauthorized user whether a given person is a patient at this clinic. Both cases should
  look identical from outside.

### Data and soft delete

- Archived patients must vanish from search while remaining reachable by direct reference
  from historical appointments and notes.
- **Uniqueness under soft delete.** If email or MRN is unique, an archived row still
  occupies that value and blocks re-registration. Requires partial unique indexes scoped to
  non-archived rows.
- Archiving a patient: do their notes, prescriptions, and appointments archive too — and
  can that be reversed as a single operation?
- Audit log volume. Every _read_ is logged, so a busy clinic generates millions of rows.
  Needs time-based partitioning and an archival tier, and it must never slow the request
  path enough that somebody proposes turning it off.

### Auth

- Rate limiting must be **per-account and per-IP simultaneously**. Per-IP alone misses
  distributed credential stuffing; per-account alone lets a single IP spray many accounts.
- Idle timeout and absolute session lifetime are different controls. Both are needed.
- Shared front-desk workstations: aggressive auto-logoff plus fast re-authentication, or
  staff will work around it by sharing an account — defeating unique user identification.
- Session fixation, and rotating the session identifier on privilege change.

---

## 4. Main entities

**Identity and access** — Clinic · User · Role · UserRole · Session · ProviderProfile
(NPI, specialty, license: doctor-specific attributes that don't belong on every user)

**Patient domain** — Patient · PatientIdentifier (MRN) · Allergy · MedicalFlag

**Scheduling** — AppointmentType · ProviderAvailability · ClinicClosure · Appointment

**Clinical** — VisitNote · VisitNoteVersion · Prescription · PrescriptionItem · Medication

**Compliance** — AuditEvent · BreakGlassAccess

Deferred, but shaping the model now: Attachment, Room/Resource, PatientMergeRecord.

Field types, sensitivity marking, foreign keys, indexes, and the note-versioning mechanics
belong to the data model document that follows this one.

---

## 5. Main user flows

**Receptionist — register a patient.** Search first to avoid duplicates → enter demographics
and contact details → system issues an MRN → record NPP acknowledgment. Every search that
returns results is itself an audited read.

**Receptionist — book an appointment.** Find patient → choose provider and appointment type
→ system offers slots derived from clinic hours, provider availability, closures, and
existing bookings → confirm. Slot conflicts are resolved at the database, not in the UI.

**Receptionist — check in.** Today's clinic schedule → mark arrived → patient appears on
the doctor's list. This is the handoff between the front desk and the clinical side, and
it is the only place the two roles' views meet.

**Doctor — see a patient.** Own schedule for today → open chart → allergies and medical
flags surfaced before anything else → review history → write note (draft, autosaved) →
sign. Signing freezes that version.

**Doctor — prescribe.** From an open visit → select medication → dosage, quantity,
instructions → sign → print. Written into the patient's permanent history.

**Doctor — amend after signing.** The original stays intact; an addendum is attached,
attributed, and timestamped.

**Administrator — staff lifecycle.** Create account → assign roles → later change roles or
deactivate. Deactivation must terminate live sessions and surface any future appointments
belonging to that provider.

**Administrator — audit review.** Filter by patient, actor, and date range. Break-glass
events and other flagged patterns are visible without hunting for them.

**Cross-cutting — login.** Credentials → rate-limited → session established → idle and
absolute timeouts enforced → every subsequent request resolves permissions against current
state rather than against a snapshot taken at login.

---

## 6. Development phases

**Phase 1 — Foundation.** Next.js + TypeScript skeleton, PostgreSQL via Docker Compose,
Drizzle wired with explicit migrations, health check endpoint, CI running
lint/typecheck/test, secrets handling. No PHI exists yet, which makes this the cheapest
moment to get the plumbing right.

**Phase 2 — Identity, access, and audit.** Clinic, User, Role, Session. Authentication,
password hashing, rate limiting, idle and absolute timeouts. The central authorization
primitive. **The audit log ships in this phase, before any patient data exists.**

**Phase 3 — Patient core.** Patient, MRN, demographics, allergies, medical flags. Register,
search, view, archive. All reads flow through the audited access layer built in Phase 2.
First real PHI enters the system here.

**Phase 4 — Scheduling.** Clinic hours, closures, provider availability, appointment types,
appointments with database-level conflict prevention, check-in, clinic and per-provider
schedule views.

**Phase 5 — Clinical documentation.** Visit notes with draft/signed/addendum versioning,
optimistic concurrency, patient history view.

**Phase 6 — Prescriptions.** Medication reference data, prescribing, printing, prescription
history. Controlled substances blocked at the model level.

**Phase 7 — Administration.** Clinic configuration, audit log viewer with flagging, staff
management UI, dashboard.

**Phase 8 — Hardening and operations.** Automated encrypted backups **with a tested
restore**, monitoring and alerting, structured logging with PHI redaction verified,
security review, load check on the audit path.

---

## 7. What to build first, and why

**Phase 2 — the authorization primitive and the audit log — before any patient data
exists.**

The reasoning is specific, not general good practice.

**Audit logging cannot be retrofitted honestly.** If patient reads go live in Phase 3 and
auditing arrives in Phase 5, there is a window the system can never account for. In a
breach investigation, "we hadn't built that yet" is not an answer anyone can use. The log
has to predate the first row of PHI.

**Scattered authorization checks fail at the margin.** If twenty server actions each
hand-roll their own role check, that is twenty chances to get it wrong — and the one that
is wrong will not be the one anybody thinks to review. One primitive, used everywhere, is
one thing to review and one thing to fix.

**Make unaudited access structurally impossible.** The strongest version of this: a single
data-access module is the _only_ code permitted to read patient tables. It takes an actor,
a target, and a stated purpose; it authorizes, it reads, and it writes the audit row in the
same transaction. Reading PHI without logging it stops being something a developer can
forget and becomes something the codebase has no path for. Building this after Phase 3
means retrofitting every call site instead.

The corollary is worth stating plainly: **do not start with the patient CRUD screens**,
even though they feel like the real beginning of the product. Every one of them would be
written against an access layer that doesn't exist yet, and rewritten once it does.

---

## 8. HIPAA-specific items that change the design

These are not policy footnotes. Each one alters schema, code structure, or infrastructure.

| Requirement                                      | Effect on Cliniqo                                                                                                                                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Audit controls** §164.312(b)                   | Reads are logged, not only writes. Drives the audited-access-layer architecture.                                                                                                                                  |
| **6-year retention** §164.316(b)(2)(i)           | Audit table is append-only, immutable even to administrators, and partitioned by time to stay fast.                                                                                                               |
| **Minimum necessary** §164.502(b)                | Field-level scoping, not just row-level. This is why the receptionist view is a different projection of the patient record rather than the same query with parts hidden in the UI.                                |
| **Unique user identification** §164.312(a)(2)(i) | No shared accounts. Front-desk workstation UX must make individual login painless, or it will be circumvented.                                                                                                    |
| **Emergency access** §164.312(a)(2)(ii)          | Break-glass is _required_, not optional. Needs a real path, a captured reason, and loud logging.                                                                                                                  |
| **Automatic logoff** §164.312(a)(2)(iii)         | Idle timeout as a first-class session concept, separate from absolute lifetime.                                                                                                                                   |
| **Encryption** §164.312(a)(2)(iv), §164.312(e)   | TLS in transit; encryption at rest for the database **and its backups**. Backups are the most commonly forgotten copy of the PHI.                                                                                 |
| **Right of access** §164.524                     | Patients can demand their record within 30 days. Record export is a compliance requirement, not a nice-to-have.                                                                                                   |
| **Right to amend** §164.526                      | Corrections are addenda that preserve the original. This is the reason note versioning exists.                                                                                                                    |
| **Accounting of disclosures** §164.528           | Patients may ask who their data was disclosed to, going back 6 years. The audit log must answer this per-patient, which shapes its indexes.                                                                       |
| **Breach notification** §164.400–414             | 60-day clock. The log must answer "exactly whose records did this account touch" quickly and defensibly.                                                                                                          |
| **Contingency plan** §164.308(a)(7)              | Backups alone are insufficient — a **tested** restore is required. Phase 8 includes an actual restore drill, not just a backup job.                                                                               |
| **De-identification** §164.514                   | No production PHI in development or test. Requires a synthetic seed-data strategy from Phase 3 onward.                                                                                                            |
| **Business associate agreements**                | Every vendor touching PHI needs one: hosting, managed database, error tracking, log aggregation, email, backup storage. This constrains vendor choice before the first deploy, so it belongs in Phase 1 planning. |

---

## Open decisions blocking the data model

1. Doctor scope — all patients, or own patients with break-glass? (§1)
2. Billing — confirm removal from the MVP. (§1)
3. Prescriptions — record-and-print only? (M1)
4. Multi-tenancy — carry `clinic_id` even for a single clinic? (M2)
5. Note lifecycle — adopt draft / signed / addendum? (M5)
6. Multiple roles per user? (M12)
