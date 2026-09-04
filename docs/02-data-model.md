# Cliniqo — Data Model (Phase 1)

No code. This is a specification for review; Drizzle schema and migrations follow only
after sign-off.

---

## Assumptions adopted

The six decisions left open by [01-requirements-analysis.md](01-requirements-analysis.md)
are resolved here as follows. Each is reversible before implementation; some get expensive
after.

| #   | Decision       | Adopted                                                                                         | Cost to reverse later                                             |
| --- | -------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | Doctor scope   | Doctors see **all patients at their clinic**. Detection (audit + flagging) replaces prevention. | Low — add a care-relationship table and tighten the access layer. |
| 2   | Billing        | **Out of the MVP.** Removed from the role matrix.                                               | Low.                                                              |
| 3   | Prescriptions  | **Record-and-print only.** Controlled substances blocked at the model level.                    | High — e-prescribing reshapes the prescription tables.            |
| 4   | Multi-tenancy  | `clinic_id` carried on every tenant-scoped table. No tenant-switching UI.                       | Very high — this is the one that must be right now.               |
| 5   | Note lifecycle | **draft → signed → addendum.**                                                                  | Medium.                                                           |
| 6   | Multiple roles | Yes, via a `user_role` join table.                                                              | Medium.                                                           |

Also adopted from the analysis: clinic-issued MRN, coded appointment types (no free-text
reason at the front desk), no self-service password reset, structured allergies with no
interaction checking, and legal/preferred name plus sex-assigned-at-birth and gender
identity as separate fields.

**On decision 1.** Letting every doctor see every chart is normal for a single small
clinic and matches the stated requirement. It has a direct consequence worth stating: once
permission checks can no longer distinguish legitimate from illegitimate access, the audit
log stops being a compliance formality and becomes the _only_ control that catches a
clinician reading their neighbour's chart. That is why §6 carries flagging, and why the
log is treated as a first-class part of the model rather than a side table.

---

## Conventions

- **Primary keys** are `uuid`, generated as UUIDv7 (time-ordered, so index locality does
  not degrade the way v4 does on high-insert tables like `audit_event`).
- **All timestamps** are `timestamptz`, stored UTC, rendered in `clinic.timezone`.
- **Soft delete** is `archived_at timestamptz NULL` + `archived_by uuid` +
  `archive_reason text`. A row with `archived_at IS NULL` is live. There are no hard
  deletes of clinical data anywhere in this model.
- **Optimistic concurrency** is an `integer` `version` column, incremented on write and
  checked against the client's copy, on every table a second user can edit concurrently.
- **Tenancy** is `clinic_id uuid NOT NULL` on every table below except the global
  reference tables (`role`, `permission`, `medication`).
- **Clinical correction** uses a status of `entered_in_error` rather than deletion,
  matching how clinical systems retract mistaken data.

### Sensitivity legend

| Mark  | Meaning                                                                                                           |
| ----- | ----------------------------------------------------------------------------------------------------------------- |
| **C** | Clinical PHI — diagnoses, notes, medications, allergies. Highest restriction.                                     |
| **I** | Identifying PHI — name, DOB, contact, MRN. Still PHI: the mere fact that a person is a patient here is protected. |
| **S** | Secret — credentials and tokens. Not PHI, but must never leave the server or appear in logs.                      |
| **·** | Operational, non-sensitive.                                                                                       |

A note on **I**: it is a common and expensive mistake to treat only clinical columns as
protected. Under HIPAA, every column on `patient` is PHI, because the row's existence
links an identifiable person to a healthcare provider. Front-desk staff see **I** but not
**C** — that is the minimum-necessary boundary, and it is a _different projection of the
row_, not the same query with fields hidden in the UI.

---

## 1. Staff, users, and roles

### `user_account`

One row per human. No shared accounts (§164.312(a)(2)(i)).

| Field                                            | Type                   | Sens. | Notes                                             |
| ------------------------------------------------ | ---------------------- | :---: | ------------------------------------------------- |
| `id`                                             | uuid PK                |   ·   |                                                   |
| `clinic_id`                                      | uuid FK → clinic       |   ·   |                                                   |
| `email`                                          | citext                 |   ·   | Login identifier                                  |
| `password_hash`                                  | text                   | **S** | Argon2id; parameters embedded in the encoded hash |
| `password_changed_at`                            | timestamptz            |   ·   |                                                   |
| `must_change_password`                           | boolean                |   ·   | Set by admin-issued reset                         |
| `full_name`                                      | text                   |   ·   |                                                   |
| `status`                                         | enum                   |   ·   | `active` \| `suspended` \| `deactivated`          |
| `failed_login_count`                             | integer                |   ·   |                                                   |
| `locked_until`                                   | timestamptz            |   ·   | Per-account lockout                               |
| `last_login_at`                                  | timestamptz            |   ·   |                                                   |
| `created_at` / `updated_at`                      | timestamptz            |   ·   |                                                   |
| `created_by`                                     | uuid FK → user_account |   ·   | Nullable for the seed admin                       |
| `version`                                        | integer                |   ·   | Optimistic concurrency                            |
| `archived_at` / `archived_by` / `archive_reason` | —                      |   ·   | Soft delete                                       |

**Relationships:** `clinic` 1—N `user_account`. `user_account` 1—N `session`,
1—N `user_role`, 1—0..1 `provider_profile`.

**Indexes:** unique on `(clinic_id, lower(email))` **partial where `archived_at IS NULL`**
— an archived account must not permanently block re-use of an address. Index
`(clinic_id, status)` for the staff list.

### `role`, `permission`, `role_permission`

Global reference tables, seeded, not clinic-scoped.

- `role` — `id`, `code` (`admin` \| `doctor` \| `receptionist`), `display_name`,
  `description`. All `·`.
- `permission` — `id`, `code` (e.g. `patient.read.identifying`, `patient.read.clinical`,
  `note.sign`, `prescription.create`, `audit.read`), `description`. All `·`.
- `role_permission` — `role_id` FK, `permission_id` FK. Composite PK.

**Why the extra indirection for three roles.** The access layer checks _permissions_, never
role names. Adding a nurse role later becomes a seed-data change plus one row of grants,
rather than a grep for `=== 'doctor'` across every server action and a re-audit of each
hit. Two small reference tables buy that.

### `user_role`

| Field                       | Type                   | Sens. | Notes                                   |
| --------------------------- | ---------------------- | :---: | --------------------------------------- |
| `id`                        | uuid PK                |   ·   |                                         |
| `user_id`                   | uuid FK → user_account |   ·   |                                         |
| `role_id`                   | uuid FK → role         |   ·   |                                         |
| `granted_at` / `granted_by` | —                      |   ·   |                                         |
| `revoked_at` / `revoked_by` | —                      |   ·   | Revocations are retained, never deleted |

**Relationship:** M—N between `user_account` and `role`, resolved through this table, so
the owner-physician holds `admin` and `doctor` on one account.

**Indexes:** unique `(user_id, role_id)` **partial where `revoked_at IS NULL`** — one live
grant per pair, while history accumulates. Index `(user_id)` where `revoked_at IS NULL`
(read on every request).

### `provider_profile`

1—0..1 with `user_account`; exists only for clinicians.

`user_id` (PK and FK) · | `npi` · | `license_number` · | `license_state` · |
`license_expires_on` · | `specialty` · | `can_prescribe` boolean · |
`default_appointment_duration_minutes` ·

No DEA number: controlled-substance prescribing is out of scope, and storing a DEA number
for a capability the system does not offer is a liability with no benefit.

### `session`

| Field                         | Type        | Sens. | Notes                                                                                                      |
| ----------------------------- | ----------- | :---: | ---------------------------------------------------------------------------------------------------------- |
| `id`                          | uuid PK     |   ·   |                                                                                                            |
| `user_id`                     | uuid FK     |   ·   |                                                                                                            |
| `token_hash`                  | text        | **S** | SHA-256 of the token. **The raw token is never stored** — a database read must not yield a usable session. |
| `created_at` / `last_seen_at` | timestamptz |   ·   |                                                                                                            |
| `idle_expires_at`             | timestamptz |   ·   | Automatic logoff, §164.312(a)(2)(iii)                                                                      |
| `absolute_expires_at`         | timestamptz |   ·   | Independent ceiling                                                                                        |
| `ip_address`                  | inet        |   ·   |                                                                                                            |
| `user_agent`                  | text        |   ·   |                                                                                                            |
| `revoked_at`                  | timestamptz |   ·   |                                                                                                            |
| `revoked_reason`              | enum        |   ·   | `logout` \| `idle_timeout` \| `absolute_timeout` \| `role_change` \| `deactivated` \| `admin_revoke`       |

**Indexes:** unique on `token_hash`; `(user_id)` partial where `revoked_at IS NULL` — this
is the index that makes "deactivate a user and kill their live sessions now" a single
cheap statement; `(absolute_expires_at)` for the reaper.

Sessions carry identity only. Permissions are resolved from `user_role` on every request,
so a role change or deactivation takes effect immediately rather than at token expiry.

### `auth_attempt`

`id` · | `clinic_id` · | `email_attempted` citext · | `user_id` (nullable FK) · |
`ip_address` inet · | `succeeded` boolean · | `attempted_at` ·

**Indexes:** `(lower(email_attempted), attempted_at DESC)` and
`(ip_address, attempted_at DESC)` — two indexes because rate limiting must be per-account
_and_ per-IP simultaneously. Retained 90 days; this is operational security telemetry, not
an audit record, and it lives on a different clock from `audit_event`.

---

## 2. Patients

### `patient`

Every column here is PHI.

| Field                                                        | Type              | Sens. | Notes                                              |
| ------------------------------------------------------------ | ----------------- | :---: | -------------------------------------------------- |
| `id`                                                         | uuid PK           |   ·   |                                                    |
| `clinic_id`                                                  | uuid FK           |   ·   |                                                    |
| `mrn`                                                        | text              | **I** | Clinic-issued, from `clinic.mrn_prefix` + sequence |
| `legal_first_name`                                           | text              | **I** |                                                    |
| `legal_middle_name`                                          | text              | **I** |                                                    |
| `legal_last_name`                                            | text              | **I** |                                                    |
| `preferred_name`                                             | text              | **I** | What staff actually call the patient               |
| `pronouns`                                                   | text              | **I** |                                                    |
| `date_of_birth`                                              | date              | **I** |                                                    |
| `sex_assigned_at_birth`                                      | enum              | **C** | Clinically relevant — reference ranges, screening  |
| `gender_identity`                                            | text              | **I** | Distinct from the above; both are needed           |
| `phone_primary` / `phone_secondary`                          | text              | **I** |                                                    |
| `email`                                                      | citext            | **I** |                                                    |
| `address_line1` / `line2` / `city` / `state` / `postal_code` | text              | **I** |                                                    |
| `preferred_language`                                         | text              | **I** | Interpreter needs                                  |
| `emergency_contact_name` / `_phone` / `_relationship`        | text              | **I** |                                                    |
| `deceased_date`                                              | date              | **C** | Nullable                                           |
| `npp_acknowledged_at`                                        | timestamptz       |   ·   | Notice of Privacy Practices                        |
| `npp_document_version`                                       | text              |   ·   | Which version they acknowledged                    |
| `merged_into_patient_id`                                     | uuid FK → patient |   ·   | Self-reference, for duplicate resolution           |
| `search_vector`                                              | tsvector          | **I** | Generated; see §8                                  |
| `registered_by` / `registered_at`                            | —                 |   ·   |                                                    |
| `created_at` / `updated_at` / `version`                      | —                 |   ·   |                                                    |
| `archived_at` / `archived_by` / `archive_reason`             | —                 |   ·   |                                                    |

**Relationships:** `clinic` 1—N `patient`. `patient` 1—N `patient_allergy`, `patient_flag`,
`appointment`, `visit_note`, `prescription`, `audit_event`.

**Indexes:**

- Unique `(clinic_id, mrn)` — **not** partial. Unlike email, an MRN must never be reused,
  even after archival: it identifies a chart that still exists in the record. This
  asymmetry with `user_account.email` is deliberate.
- GIN on `search_vector` — the primary patient search path.
- Trigram (`pg_trgm`) on `legal_last_name` and `preferred_name` — typo-tolerant lookup.
  Front-desk staff mistype names constantly, and a failed search is what causes a duplicate
  chart to be created.
- `(clinic_id, date_of_birth)` — the standard disambiguation when two names collide.
- `(clinic_id, phone_primary)` — inbound-call lookup.
- `(clinic_id)` partial where `archived_at IS NULL` — the active-roster scan.

### `patient_allergy`

`id` · | `patient_id` FK · | `clinic_id` FK · | `allergen_type` enum
(`drug`\|`food`\|`environmental`\|`other`) **C** | `allergen_name` text **C** |
`allergen_code` text **C** (nullable; RxNorm/SNOMED slot for later) | `reaction` text **C** |
`severity` enum (`mild`\|`moderate`\|`severe`\|`life_threatening`) **C** |
`onset_date` date **C** | `status` enum (`active`\|`inactive`\|`entered_in_error`) · |
`recorded_by` / `recorded_at` · | `version` · | `archived_*` ·

**Index:** `(patient_id)` partial where `status = 'active'` — read on every chart open and
surfaced before anything else.

### `patient_flag`

Medical alerts: infection control, fall risk, safeguarding concerns.

`id` · | `patient_id` FK · | `clinic_id` FK · | `flag_type` enum · | `label` text **C** |
`detail` text **C** | `severity` enum · | `valid_from` / `valid_to` date · |
`created_by` / `created_at` · | `archived_*` ·

**Index:** `(patient_id)` partial where `valid_to IS NULL OR valid_to >= now()`.

---

## 3. Clinic configuration and scheduling

### `clinic`

`id` · | `name` · | `timezone` text (IANA) · | `npi` · | address columns · | `phone` · |
`mrn_prefix` text · | `mrn_sequence` bigint · | `created_at`/`updated_at` · | `archived_*` ·

Non-PHI: the clinic is the covered entity, not a patient.

### `clinic_hours`

`id` · | `clinic_id` FK · | `day_of_week` smallint (0–6) · | `opens_at` time · |
`closes_at` time ·

Multiple rows per weekday are permitted, which is how split shifts and lunch closures are
represented. **Index:** `(clinic_id, day_of_week)`.

### `schedule_exception`

One table covers both clinic-wide closures and individual provider time off, distinguished
by whether `provider_user_id` is null.

`id` · | `clinic_id` FK · | `provider_user_id` FK **nullable** · | `during` tstzrange · |
`kind` enum (`closure`\|`time_off`\|`blocked`) · | `reason` text · | `created_by`/`created_at` ·

**Index:** GiST on `(clinic_id, during)`; `(provider_user_id, during)` GiST.

### `appointment_type`

`id` · | `clinic_id` FK · | `code` text · | `display_name` text · |
`default_duration_minutes` integer · | `color` text · | `is_active` boolean · |
`sort_order` integer ·

This table is the fix for the front-desk PHI leak: receptionists choose a coded type rather
than typing a reason. **Index:** unique `(clinic_id, code)`.

### `provider_availability`

`id` · | `clinic_id` FK · | `provider_user_id` FK · | `day_of_week` smallint · |
`starts_at` / `ends_at` time · | `effective_from` / `effective_to` date ·

**Index:** `(provider_user_id, day_of_week)`.

### `appointment`

| Field                                                   | Type                  | Sens. | Notes                                                                      |
| ------------------------------------------------------- | --------------------- | :---: | -------------------------------------------------------------------------- |
| `id`                                                    | uuid PK               |   ·   |                                                                            |
| `clinic_id`                                             | uuid FK               |   ·   |                                                                            |
| `patient_id`                                            | uuid FK               | **I** | The association itself is PHI                                              |
| `provider_user_id`                                      | uuid FK               |   ·   |                                                                            |
| `appointment_type_id`                                   | uuid FK               | **C** | A coded type still implies clinical content                                |
| `during`                                                | tstzrange             | **I** | Authoritative time; enables the exclusion constraint                       |
| `starts_at` / `ends_at`                                 | timestamptz           | **I** | Generated from `during`; see §8                                            |
| `status`                                                | enum                  |   ·   | `booked`\|`checked_in`\|`in_progress`\|`completed`\|`cancelled`\|`no_show` |
| `booking_note`                                          | text                  | **I** | Front-desk visible. Logistics only — see caveat below                      |
| `clinical_note_for_provider`                            | text                  | **C** | Clinician-only projection                                                  |
| `checked_in_at` / `checked_in_by`                       | —                     |   ·   |                                                                            |
| `cancelled_at` / `cancelled_by` / `cancellation_reason` | —                     |   ·   |                                                                            |
| `rescheduled_from_appointment_id`                       | uuid FK → appointment |   ·   | Self-reference; preserves the reschedule chain                             |
| `created_by` / `created_at` / `updated_at` / `version`  | —                     |   ·   |                                                                            |
| `archived_*`                                            | —                     |   ·   |                                                                            |

**Constraints:**

- Exclusion constraint over `(provider_user_id WITH =, during WITH &&)` using GiST with
  `btree_gist`, **partial, excluding `cancelled` and `no_show`**. The partiality is not
  optional: without it, a cancelled appointment blocks its slot permanently. This is the
  only thing that actually prevents two receptionists from double-booking the same slot
  concurrently — an application-level availability check cannot, because both requests
  read "free" before either writes.
- Check that `upper(during) > lower(during)`.

**Indexes:** the exclusion constraint supplies the provider/time GiST index. Additionally
GiST `(clinic_id, during)` for the clinic day view; `(patient_id, starts_at DESC)` for
patient history; `(clinic_id, starts_at)` partial where `status IN ('booked','checked_in')`
for today's arrivals board.

**Caveat on `booking_note`.** Coded types remove the _need_ for free text, but staff will
still occasionally type clinical detail into a logistics field. The model cannot prevent
this. Mitigation is operational: label the field explicitly as logistics-only, and include
it in the periodic audit review sample.

---

## 4. Visit notes

Split into a stable container and immutable content versions.

### `visit_note`

| Field                                            | Type                         | Sens. | Notes                                             |
| ------------------------------------------------ | ---------------------------- | :---: | ------------------------------------------------- |
| `id`                                             | uuid PK                      |   ·   | Stable identity of "the note for this visit"      |
| `clinic_id`                                      | uuid FK                      |   ·   |                                                   |
| `patient_id`                                     | uuid FK                      | **I** |                                                   |
| `appointment_id`                                 | uuid FK **nullable**         |   ·   | Null for walk-ins with no booking                 |
| `author_user_id`                                 | uuid FK                      |   ·   | Original author                                   |
| `status`                                         | enum                         |   ·   | `draft` \| `signed` \| `amended`                  |
| `current_version_id`                             | uuid FK → visit_note_version |   ·   | Denormalized pointer; see §8                      |
| `signed_at` / `signed_by`                        | —                            |   ·   |                                                   |
| `created_at` / `updated_at`                      | —                            |   ·   |                                                   |
| `version`                                        | integer                      |   ·   | Optimistic concurrency between concurrent editors |
| `archived_at` / `archived_by` / `archive_reason` | —                            |   ·   |                                                   |

**Indexes:** `(patient_id, created_at DESC)` — the chart timeline;
`(appointment_id)` unique partial where `archived_at IS NULL`; `(author_user_id, status)`
partial where `status = 'draft'` — the "your unsigned notes" queue, which is the thing
that stops notes being forgotten.

### `visit_note_version`

Append-only. No `archived_at` — versions are never deleted or archived, because that is
the entire point of them.

| Field                   | Type                         | Sens. | Notes                                               |
| ----------------------- | ---------------------------- | :---: | --------------------------------------------------- |
| `id`                    | uuid PK                      |   ·   |                                                     |
| `visit_note_id`         | uuid FK                      |   ·   |                                                     |
| `version_number`        | integer                      |   ·   | 1-based, monotonic within the note                  |
| `kind`                  | enum                         |   ·   | `draft` \| `signed` \| `addendum`                   |
| `chief_complaint`       | text                         | **C** |                                                     |
| `subjective`            | text                         | **C** |                                                     |
| `objective`             | text                         | **C** |                                                     |
| `assessment`            | text                         | **C** |                                                     |
| `plan`                  | text                         | **C** |                                                     |
| `authored_by_user_id`   | uuid FK                      |   ·   | May differ from the note's original author          |
| `authored_at`           | timestamptz                  |   ·   |                                                     |
| `frozen_at`             | timestamptz                  |   ·   | Null while the draft is still mutable               |
| `supersedes_version_id` | uuid FK → visit_note_version |   ·   |                                                     |
| `content_hash`          | text                         |   ·   | Tamper evidence; chains to the prior version's hash |

**Indexes:** unique `(visit_note_id, version_number)`; `(visit_note_id, version_number DESC)`
for history retrieval.

The SOAP split (subjective / objective / assessment / plan) rather than one text blob is
deliberate: it matches how clinicians are trained to document, it makes the assessment
field independently retrievable for history summaries, and it means a future structured-data
requirement does not need a text-parsing migration.

---

## 5. Prescriptions

### `medication`

Global reference table. Non-PHI — this is a formulary, not patient data.

`id` · | `name` · | `generic_name` · | `form` · | `strength` · | `rxnorm_code` (nullable) · |
`is_controlled` boolean · | `dea_schedule` text (nullable) · | `is_active` boolean ·

**Index:** trigram on `name` and `generic_name` for prescriber search.

`is_controlled` exists specifically so that the out-of-scope decision is enforced by data
rather than by memory: a medication flagged controlled cannot be added to a prescription.

### `prescription` (order header)

`id` · | `clinic_id` FK · | `patient_id` FK **I** | `visit_note_id` FK nullable · |
`prescriber_user_id` FK · | `status` enum (`draft`\|`signed`\|`printed`\|`cancelled`) · |
`signed_at` · | `printed_at` · | `cancelled_at`/`cancelled_by`/`cancellation_reason` · |
`created_at`/`updated_at`/`version` · | `archived_*` ·

**Indexes:** `(patient_id, signed_at DESC)` — prescription history;
`(prescriber_user_id, status)` partial where `status = 'draft'`.

### `prescription_item` (order line)

`id` · | `prescription_id` FK · | `medication_id` FK · | `sequence` integer · |
`dose` text **C** | `route` text **C** | `frequency` text **C** | `duration_days` integer **C** |
`quantity` numeric **C** | `quantity_unit` text **C** | `refills` integer **C** |
`instructions` text (sig) **C** | `indication` text **C**

No soft-delete columns. Once the parent prescription is signed, items are immutable;
correction happens by cancelling the prescription and issuing a new one, which is how
paper prescriptions work and what the legal record expects.

**Index:** `(prescription_id, sequence)`.

---

## 6. Audit

### `audit_event`

Append-only, range-partitioned monthly on `occurred_at`.

| Field                  | Type                   | Sens. | Notes                                                                     |
| ---------------------- | ---------------------- | :---: | ------------------------------------------------------------------------- |
| `id`                   | uuid PK                |   ·   | UUIDv7 — time-ordered, keeps insert locality on a huge table              |
| `occurred_at`          | timestamptz            |   ·   | Partition key                                                             |
| `clinic_id`            | uuid                   |   ·   | Denormalized                                                              |
| `actor_user_id`        | uuid FK → user_account |   ·   |                                                                           |
| `actor_role_codes`     | text[]                 |   ·   | **Snapshot** of roles at the moment of action                             |
| `actor_ip`             | inet                   |   ·   |                                                                           |
| `actor_user_agent`     | text                   |   ·   |                                                                           |
| `session_id`           | uuid                   |   ·   | Correlates a run of actions to one login                                  |
| `action`               | text                   |   ·   | `patient.search`, `patient.read`, `note.read`, `note.sign`, …             |
| `outcome`              | enum                   |   ·   | `allowed` \| `denied` \| `error`                                          |
| `subject_patient_id`   | uuid FK → patient      | **I** | Whose PHI was touched. See §10                                            |
| `entity_type`          | enum                   |   ·   | `patient`\|`appointment`\|`visit_note`\|`prescription`\|`user_account`\|… |
| `entity_id`            | uuid                   |   ·   | Polymorphic — **no FK constraint**. See §10                               |
| `purpose`              | text                   |   ·   | Stated reason; required for break-glass                                   |
| `break_glass_grant_id` | uuid FK nullable       |   ·   |                                                                           |
| `request_id`           | text                   |   ·   | Correlates to application logs                                            |
| `metadata`             | jsonb                  |   ·   | Field _names_ accessed, result counts. **Never PHI values**               |

No `updated_at`, no `archived_at`, no `version`. The application database role holds
`INSERT` and `SELECT` on this table and nothing else — immutability is enforced by
**database privilege**, not by application discipline, so that compromising an admin
account does not let anyone rewrite the log.

**Indexes:**

- `(subject_patient_id, occurred_at DESC)` — accounting of disclosures, §164.528.
- `(actor_user_id, occurred_at DESC)` — breach scoping: "exactly what did this account
  touch." This is the query that runs against the 60-day clock.
- `(entity_type, entity_id, occurred_at DESC)` — history of one record.
- `(clinic_id, occurred_at DESC)` — general review.
- Partial where `break_glass_grant_id IS NOT NULL` — emergency access review queue.
- Partial where `outcome = 'denied'` — attempted boundary violations. Small, and the most
  interesting index in the schema.

### `break_glass_grant`

`id` · | `clinic_id` FK · | `user_id` FK · | `patient_id` FK **I** | `reason` text (required) · |
`granted_at` · | `expires_at` (short, hours) · | `revoked_at`/`revoked_by` · |
`reviewed_at`/`reviewed_by` · | `review_outcome` enum (`pending`\|`justified`\|`not_justified`) ·

**Index:** `(clinic_id)` partial where `review_outcome = 'pending'` — the queue that makes
§164.312(a)(2)(ii) a real procedure rather than a checkbox.

---

## 7. Entity relationship diagram

```
                            ┌────────────┐
                            │   clinic   │
                            └─────┬──────┘
        ┌─────────────┬───────────┼────────────┬──────────────┐
        │             │           │            │              │
        ▼             ▼           ▼            ▼              ▼
 ┌────────────┐ ┌──────────┐ ┌─────────┐ ┌──────────┐ ┌──────────────┐
 │clinic_hours│ │ schedule │ │appoint- │ │   user   │ │   patient    │
 │            │ │_exception│ │ment_type│ │ _account │ │              │
 └────────────┘ └────┬─────┘ └────┬────┘ └────┬─────┘ └──────┬───────┘
                     │            │           │              │
                     │ (nullable  │           │              ├──< patient_allergy
                     │  provider) │           │              ├──< patient_flag
                     └────────────┼───────────┤              │
                                  │           │              │
   ┌──────────────────────────────┘           │              │
   │                                          │              │
   │  ┌───────────────────────────────────────┤              │
   │  │                                       │              │
   │  │  user_account ──1:N──< user_role >──N:1── role        │
   │  │                                        │             │
   │  │                                        └──< role_permission >── permission
   │  │                                                      │
   │  ├──1:0..1──> provider_profile                          │
   │  ├──1:N─────< session                                   │
   │  │                                                      │
   ▼  ▼                                                      ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │                          appointment                            │
 │  clinic_id, patient_id, provider_user_id, appointment_type_id   │
 │  during tstzrange  ── EXCLUDE(provider =, during &&) partial    │
 │  rescheduled_from_appointment_id ──┐ (self)                     │
 └───────────┬─────────────────────────┴───────────────────────────┘
             │ 1:0..1
             ▼
 ┌───────────────────────┐          ┌───────────────────────────┐
 │      visit_note       │──1:N────<│    visit_note_version     │
 │  status, current_ ────┼─────────>│  version_number, kind,    │
 │  version_id           │  0..1    │  SOAP fields, frozen_at,  │
 │  patient_id           │          │  supersedes_version_id ─┐ │
 └───────────┬───────────┘          └─────────────────────────┴─┘
             │ 1:N                                    (self)
             ▼
 ┌───────────────────────┐          ┌───────────────────────────┐
 │     prescription      │──1:N────<│    prescription_item      │
 │  patient_id,          │          │  dose, sig, refills       │
 │  prescriber_user_id,  │          │  medication_id ───────────┼──> medication
 │  visit_note_id        │          └───────────────────────────┘    (global ref)
 └───────────────────────┘

 ┌─────────────────────────────────────────────────────────────────┐
 │                          audit_event                            │
 │                                                                 │
 │   actor_user_id ────────FK────────> user_account                │
 │   subject_patient_id ───FK────────> patient      ← strong        │
 │   break_glass_grant_id ─FK────────> break_glass_grant           │
 │                                                                 │
 │   (entity_type, entity_id) ┄┄┄no FK┄┄> patient | appointment |  │
 │                                        visit_note | prescription│
 │                                        | user_account | ...     │
 │                                                    ← weak        │
 │   actor_role_codes[]  ← point-in-time snapshot, not a join      │
 └─────────────────────────────────────────────────────────────────┘

 break_glass_grant ──N:1──> user_account
                   ──N:1──> patient
```

**Cardinality summary**

| From                    | To                                                                                     | Card.                         |
| ----------------------- | -------------------------------------------------------------------------------------- | ----------------------------- |
| clinic                  | user_account, patient, appointment, appointment_type, clinic_hours, schedule_exception | 1—N                           |
| user_account            | role                                                                                   | M—N (via `user_role`)         |
| role                    | permission                                                                             | M—N (via `role_permission`)   |
| user_account            | provider_profile                                                                       | 1—0..1                        |
| user_account            | session, auth_attempt                                                                  | 1—N                           |
| patient                 | patient_allergy, patient_flag, appointment, visit_note, prescription                   | 1—N                           |
| patient                 | patient (merge target)                                                                 | N—0..1 self                   |
| provider (user_account) | appointment                                                                            | 1—N                           |
| appointment             | appointment (reschedule source)                                                        | N—0..1 self                   |
| appointment             | visit_note                                                                             | 1—0..1                        |
| visit_note              | visit_note_version                                                                     | 1—N                           |
| visit_note_version      | visit_note_version (supersedes)                                                        | N—0..1 self                   |
| visit_note              | prescription                                                                           | 1—N                           |
| prescription            | prescription_item                                                                      | 1—N                           |
| medication              | prescription_item                                                                      | 1—N                           |
| patient                 | audit_event                                                                            | 1—N (as `subject_patient_id`) |
| user_account            | audit_event                                                                            | 1—N (as `actor_user_id`)      |

---

## 8. Normalization and denormalization

### Normalized deliberately

**`user_role` as a join table** rather than a role column. Required by decision 6 — the
owner-physician holds two roles on one account, which keeps unique user identification
intact.

**`permission` / `role_permission`** so authorization checks name capabilities, not roles.
Discussed in §1.

**`visit_note` split from `visit_note_version`.** Identity and mutable status live in one
table; immutable content in the other. See §9.

**`prescription` split from `prescription_item`.** One prescribing event routinely carries
several medications; the classic header/line split. It also puts the signature on the
header, where it belongs legally.

**`schedule_exception` merges clinic closures and provider time off** into one table with a
nullable `provider_user_id`, instead of two near-identical tables. Availability calculation
then makes one pass over one table rather than reconciling two.

**`medication` as a reference table** rather than free-text drug names. This is what makes
the controlled-substance block enforceable and leaves a slot for RxNorm coding later.

### Denormalized deliberately

Each of these stores something derivable. Each has a specific reason.

**`patient.search_vector`** — a generated `tsvector` over name, MRN, and phone. Patient
search is the highest-frequency query in the application and it runs at the front desk with
someone waiting. It also has a safety dimension: a slow or literal-matching search causes
staff to give up and create a duplicate chart, and duplicate charts hide allergies.
Generated, so it cannot drift from its source columns.

**`visit_note.current_version_id`** — avoids a `MAX(version_number)` correlated subquery on
every chart open. Maintained inside the same transaction that inserts the version, so the
pointer and the row commit together or not at all.

**`appointment.starts_at` / `ends_at` as generated scalars alongside `during`** — the range
type is required for the exclusion constraint, but ordinary sorting, display, and B-tree
range scans are far more ergonomic against scalar timestamps. Generated from `during`, so
the two representations cannot disagree.

**`audit_event.actor_role_codes[]`** — this one is not really denormalization, it is
**point-in-time truth**. Roles change. Reconstructing an actor's permissions at the time of
a past action by joining to `user_role` today would produce a confident, wrong answer. The
log must record what was true when it happened.

**`audit_event.clinic_id` and `subject_patient_id`** — both reachable by join. Denormalized
so that breach scoping and disclosure accounting are single-index lookups against a
partitioned, multi-million-row table. These queries run under a 60-day statutory clock;
they should not depend on join planning.

**`clinic_id` repeated on child tables** (`patient_allergy`, `patient_flag`, `appointment`,
`visit_note`, `prescription`) even though it is reachable via the parent. This is a
**security-motivated** denormalization: every tenancy check becomes a single-table
predicate instead of a join. The simpler the check, the harder it is to write one that is
subtly wrong, and cross-tenant leaks come from exactly those subtle mistakes.

### Under-normalized deliberately

**Address as columns on `patient`, not a separate `address` table.** One address per
patient, and the MVP has no requirement for address history. A separate table would cost a
join on every chart open for a generality nobody asked for. If address history is ever
needed, it is an additive migration.

---

## 9. How visit note versioning works

### Lifecycle

**Create.** Opening a note creates the `visit_note` container plus version 1 with
`kind = 'draft'` and `frozen_at = NULL`.

**Draft.** The draft version is **mutable in place**. Autosave updates that one row.
`visit_note.version` guards concurrent editors: two clinicians open the same draft, both
save, and the second write fails its version check and surfaces a conflict rather than
silently discarding the first author's work.

**Sign.** In one transaction: `frozen_at` is set, `kind` becomes `signed`, `content_hash`
is computed, `visit_note.status` becomes `signed`, and `signed_at` / `signed_by` are
recorded. From this instant the row is never updated again.

**Amend.** After signing, corrections are **addenda**, not edits. A new
`visit_note_version` row is inserted with the next `version_number`, `kind = 'addendum'`,
and `supersedes_version_id` pointing at the previous version. The original stays fully
readable. `visit_note.status` becomes `amended` and `current_version_id` moves forward.

**Read.** The chart renders `current_version_id`. A history view walks
`version_number DESC` and shows every version with its author and timestamp.

### Why drafts are mutable — and where this deviates from the brief

The requirement said "versioned, not overwritten." Taken literally, every autosave would
create a version row, which produces hundreds of near-identical rows per note and no
benefit.

The distinction that matters clinically and legally is **signed versus unsigned**. An
unsigned draft is a working document and not part of the legal record. A signed note is,
and from that moment nothing may be overwritten. Storing every keystroke-level autosave
does not improve the legal record — it creates a large volume of discoverable half-formed
clinical impressions, which is a liability rather than an asset.

So: mutable before signing, immutable forever after. **If you want every draft save
preserved, that is a change to the write path only — the schema already supports it — but
it changes storage growth and litigation exposure, so it should be a deliberate call
rather than a default.**

### Tamper evidence

`content_hash` covers the frozen content _and the previous version's hash_, forming a chain
per note. A silent post-hoc edit at the database level breaks the chain and becomes
detectable. This is cheap to compute and turns "the note says it was signed on the 3rd"
into something verifiable.

---

## 10. How the audit log references other records

`audit_event` uses **three distinct referencing strategies**, chosen per dimension.

### Actor — strong FK plus a snapshot

`actor_user_id` is a real foreign key to `user_account`. Because there are no hard deletes,
the reference is always resolvable. Alongside it, `actor_role_codes[]` records the roles
the actor actually held at that moment, and `session_id` ties a run of actions to a single
login — which is how you tell one long browsing session from twelve suspicious ones.

### Subject — strong FK, always populated

`subject_patient_id` is a real foreign key to `patient`, and it is populated on **every**
event that touches PHI, regardless of which object was actually read. Opening a
prescription writes the prescription in `entity_id` _and_ the patient in
`subject_patient_id`.

This redundancy is the single most important design choice in the table. It makes the two
questions that carry legal deadlines into single-index lookups:

- _"Who accessed this patient's record, and when?"_ — §164.528, six years back.
- _"This account was compromised. Whose records did it touch?"_ — §164.400–414, 60 days.

Without it, answering either question means walking every entity type and resolving each
back to a patient across a partitioned table under time pressure.

### Object — polymorphic, deliberately without a FK

`(entity_type, entity_id)` identifies the specific record acted on. There is **no** foreign
key constraint, for three reasons:

1. It points at eight-plus different tables. A real FK would need eight nullable columns,
   most of them null on every row.
2. Audit rows are **evidence**, and evidence should not be constrained by the current state
   of what it describes. A log entry must remain valid regardless of what happens to the
   record afterwards.
3. FK checks on every insert would add per-write cost to the hottest-inserting table in the
   system — and audit writes sit in the request path.

The cost is real: nothing at the database level guarantees `entity_id` resolves. Three
mitigations. `entity_type` is a constrained enum, not free text. All writes go through the
single audited-access layer, which knows exactly what it just touched. And a scheduled
integrity job can sample for orphans.

### Transactional coupling

The audit row is written **in the same transaction** as the operation it records. A rolled
back operation leaves no phantom audit entry, and a committed read cannot be unlogged.

The honest tradeoff: this makes every PHI _read_ a write transaction. At clinic scale —
tens of concurrent users, not tens of thousands — this is comfortably affordable, and it is
the right trade against the alternative of an async logging path that can silently drop
events. It should be revisited if Cliniqo ever serves a hospital-sized workload.

### What must never be in the log

`metadata` records _which fields_ were accessed and _how many_ results a search returned.
It never records field values, search terms, or note content. An audit log full of PHI is a
second copy of the database with a six-year retention requirement and weaker access
controls than the original.

Denied attempts (`outcome = 'denied'`) are logged as carefully as successes. They are the
record of someone probing a boundary, and they are usually the first sign of a problem.

---

## 11. Still open

1. **Retention beyond 6 years** — state medical-record law governs and has not been
   determined (M11). Until it is, nothing is ever purged, only archived.
2. **Patient merge** — `merged_into_patient_id` reserves the shape, but the merge procedure
   (which chart's data wins, how audit history is preserved across the merge) is not
   designed.
3. **Attachments** — deferred (M7). Nothing in this model blocks adding an `attachment`
   table keyed to patient and optionally to visit note.
4. **Rooms and resources** — if the clinic schedules rooms as well as providers, the
   exclusion constraint pattern extends to a second table. Not modelled.
5. **Every draft save preserved?** — see §9.
