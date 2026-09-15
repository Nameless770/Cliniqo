/**
 * Patients, allergies, and medical flags.
 *
 * EVERY column on `patient` is PHI. It is a common and expensive mistake to treat only
 * the clinical columns as protected: under HIPAA the row's existence links an
 * identifiable person to a healthcare provider, so the name and phone number are as
 * protected as the diagnosis.
 *
 * The receptionist view is therefore a different PROJECTION of these rows (identifying
 * columns only), not the same query with fields hidden in the UI.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { clinic } from './clinic';
import {
  allergenType,
  allergySeverity,
  clinicalRecordStatus,
  flagSeverity,
  patientFlagType,
  sexAssignedAtBirth,
} from './enums';
import { userAccount } from './identity';
import {
  citext,
  primaryId,
  rowVersion,
  softDelete,
  timestamps,
  tsvector,
} from './shared';

/* -------------------------------------------------------------------------- */

export const patient = pgTable(
  'patient',
  {
    id: primaryId(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinic.id),

    /** Clinic-issued medical record number. See the uniqueness note below. */
    mrn: text('mrn').notNull(),

    // --- Identifying PHI ---------------------------------------------------
    legalFirstName: text('legal_first_name').notNull(),
    legalMiddleName: text('legal_middle_name'),
    legalLastName: text('legal_last_name').notNull(),

    /** What staff actually call the patient. Separate from legal name, which insurance needs. */
    preferredName: text('preferred_name'),
    pronouns: text('pronouns'),

    dateOfBirth: date('date_of_birth').notNull(),

    /** Clinical: drives reference ranges and screening eligibility. */
    sexAssignedAtBirth: sexAssignedAtBirth('sex_assigned_at_birth'),
    /** Free text, and deliberately a different column from the above. */
    genderIdentity: text('gender_identity'),

    phonePrimary: text('phone_primary'),
    phoneSecondary: text('phone_secondary'),
    email: citext('email'),

    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),

    /** Interpreter needs. Recorded because failing to provide one is its own compliance problem. */
    preferredLanguage: text('preferred_language'),

    emergencyContactName: text('emergency_contact_name'),
    emergencyContactPhone: text('emergency_contact_phone'),
    emergencyContactRelationship: text('emergency_contact_relationship'),

    /** Clinical. */
    deceasedDate: date('deceased_date'),

    // --- Compliance --------------------------------------------------------
    /** Notice of Privacy Practices acknowledgment. */
    nppAcknowledgedAt: timestamp('npp_acknowledged_at', { withTimezone: true }),
    nppDocumentVersion: text('npp_document_version'),

    /** Set when this chart is merged into another as a duplicate. */
    mergedIntoPatientId: uuid('merged_into_patient_id').references(
      (): AnyPgColumn => patient.id,
    ),

    /**
     * Generated search vector over MRN, names, and phone.
     *
     * Uses the `simple` text-search config, not `english`: stemming is wrong for proper
     * nouns and would make "Hastings" and "Hasting" collide while mangling others.
     *
     * The two-argument `to_tsvector(regconfig, text)` form is required — the one-argument
     * form is STABLE, not IMMUTABLE, and PostgreSQL rejects it in a generated column.
     */
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`to_tsvector('simple',
        coalesce(mrn, '') || ' ' ||
        coalesce(legal_first_name, '') || ' ' ||
        coalesce(legal_middle_name, '') || ' ' ||
        coalesce(legal_last_name, '') || ' ' ||
        coalesce(preferred_name, '') || ' ' ||
        coalesce(phone_primary, '') || ' ' ||
        coalesce(phone_secondary, ''))`,
    ),

    registeredBy: uuid('registered_by').references(() => userAccount.id),
    registeredAt: timestamp('registered_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    /**
     * Set when the patient registered themselves online instead of at the front desk.
     *
     * A self-registered record is a NEW record, never matched to an existing one: nothing
     * the sign-up form collects proves the person is who they say, and attaching a stranger
     * to an existing chart on the strength of a name and date of birth is how portals leak
     * records. Two records for one person is the safe failure; staff merge them after
     * checking identity in person.
     */
    selfRegisteredAt: timestamp('self_registered_at', { withTimezone: true }),

    /** When a member of staff confirmed a self-registered patient's identity, and who. */
    identityVerifiedAt: timestamp('identity_verified_at', { withTimezone: true }),
    identityVerifiedBy: uuid('identity_verified_by').references(() => userAccount.id),

    ...timestamps(),
    ...rowVersion(),
    ...softDelete(() => userAccount.id),
  },
  (t) => [
    /**
     * NOT partial, unlike `user_account.email`.
     *
     * An MRN must never be reused even after the chart is archived — it identifies a
     * record that still exists. Reissuing it would silently merge two people's histories
     * in any downstream report. This asymmetry is deliberate.
     */
    uniqueIndex('patient_clinic_mrn_idx').on(t.clinicId, t.mrn),

    /** Primary search path. */
    index('patient_search_idx').using('gin', t.searchVector),

    /**
     * Typo-tolerant name lookup (pg_trgm). Front-desk staff mistype names constantly,
     * and a failed search is what causes a duplicate chart to be created — which is a
     * patient-safety problem, because an allergy on chart A is invisible on chart B.
     */
    index('patient_last_name_trgm_idx').using(
      'gin',
      sql`${t.legalLastName} gin_trgm_ops`,
    ),
    index('patient_preferred_name_trgm_idx').using(
      'gin',
      sql`${t.preferredName} gin_trgm_ops`,
    ),

    /** Standard disambiguation when two patients share a name. */
    index('patient_clinic_dob_idx').on(t.clinicId, t.dateOfBirth),
    /** Inbound-call lookup. */
    index('patient_clinic_phone_idx').on(t.clinicId, t.phonePrimary),
    /** Active roster scan. */
    index('patient_clinic_live_idx')
      .on(t.clinicId)
      .where(sql`${t.archivedAt} is null`),

    /**
     * The paginated patient list, ordered by name.
     *
     * `id` is in the index as a tiebreaker, not decoration: without a total order,
     * OFFSET pagination can show the same patient on two pages and skip another
     * entirely when two people share a name. On a patient roster that is a safety
     * problem, not a cosmetic one.
     */
    index('patient_clinic_name_idx')
      .on(t.clinicId, t.legalLastName, t.legalFirstName, t.id)
      .where(sql`${t.archivedAt} is null`),
  ],
);

/* -------------------------------------------------------------------------- */

/** Clinical PHI. Surfaced before anything else on chart open. */
export const patientAllergy = pgTable(
  'patient_allergy',
  {
    id: primaryId(),
    /**
     * Denormalized from `patient`. Security-motivated: every tenancy check becomes a
     * single-table predicate instead of a join, and simpler checks are harder to get
     * subtly wrong.
     */
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinic.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patient.id),

    allergenType: allergenType('allergen_type').notNull(),
    allergenName: text('allergen_name').notNull(),
    /** RxNorm / SNOMED slot. Unused in the MVP; reserved so coding is additive later. */
    allergenCode: text('allergen_code'),
    reaction: text('reaction'),
    severity: allergySeverity('severity'),
    onsetDate: date('onset_date'),

    status: clinicalRecordStatus('status').notNull().default('active'),

    recordedBy: uuid('recorded_by').references(() => userAccount.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),

    ...timestamps(),
    ...rowVersion(),
    ...softDelete(() => userAccount.id),
  },
  (t) => [
    index('patient_allergy_active_idx')
      .on(t.patientId)
      .where(sql`${t.status} = 'active'`),
  ],
);

/* -------------------------------------------------------------------------- */

/** Medical alerts: infection control, fall risk, safeguarding concerns. Clinical PHI. */
export const patientFlag = pgTable(
  'patient_flag',
  {
    id: primaryId(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinic.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patient.id),

    flagType: patientFlagType('flag_type').notNull(),
    label: text('label').notNull(),
    detail: text('detail'),
    severity: flagSeverity('severity').notNull().default('warning'),

    validFrom: date('valid_from'),
    validTo: date('valid_to'),

    createdBy: uuid('created_by').references(() => userAccount.id),

    ...timestamps(),
    ...rowVersion(),
    ...softDelete(() => userAccount.id),
  },
  (t) => [
    index('patient_flag_current_idx')
      .on(t.patientId)
      .where(sql`${t.archivedAt} is null`),
  ],
);

/* -------------------------------------------------------------------------- */

/**
 * A duplicate chart folded into the one that survives.
 *
 * ==========================================================================
 * WHY THIS TABLE EXISTS AT ALL
 * ==========================================================================
 *
 * Duplicate charts are a patient-safety problem, not a tidiness problem: an allergy
 * recorded on chart A is invisible to a clinician reading chart B. Two things in this
 * system produce them on purpose. The front desk creates a second record when a search
 * misses — which is why `patient_last_name_trgm_idx` exists — and patient
 * self-registration NEVER matches an existing chart, because nothing a sign-up form
 * collects proves identity and attaching a stranger to someone else's record is how a
 * portal leaks a chart. Both choices are right, and both are only safe if staff can
 * reconcile the result afterwards. That is this table.
 *
 * ==========================================================================
 * THE ROWS MOVE. THE POINTER ALONE IS NOT ENOUGH.
 * ==========================================================================
 *
 * `patient.merged_into_patient_id` marks the duplicate, but a merge that ONLY set that
 * pointer would require every query in the system to remember to follow it, and the one
 * that forgets renders an allergy invisible — reintroducing precisely the failure the
 * merge exists to fix. So the child rows are repointed at the survivor, and the pointer
 * is kept for provenance and for redirecting anyone who opens the old chart.
 *
 * `manifest` records exactly which rows moved, per table, so the merge can be reversed.
 * That matters because the failure mode here is severe and asymmetric: merging two charts
 * that turn out to be two different people has combined two individuals' records, which
 * is a breach — not a typo. Ids and counts only; never clinical content.
 *
 * ==========================================================================
 * WHAT DOES NOT MOVE
 * ==========================================================================
 *
 * `audit_event.subject_patient_id` stays on the duplicate, permanently. A §164.528
 * accounting for the old MRN must still answer "who read this chart", and the answer
 * cannot be "nobody, it was merged". The application role also holds no UPDATE on
 * `audit_event`, so this is guaranteed by privilege rather than by intention.
 *
 * `break_glass_grant` stays for the same reason: it records that someone took emergency
 * access to THAT chart, which remains true afterwards.
 */
export const patientMerge = pgTable(
  'patient_merge',
  {
    id: primaryId(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinic.id),

    /** The chart that remains. */
    survivingPatientId: uuid('surviving_patient_id')
      .notNull()
      .references((): AnyPgColumn => patient.id),
    /** The chart folded in. Keeps its MRN and its row forever — see the module note. */
    duplicatePatientId: uuid('duplicate_patient_id')
      .notNull()
      .references((): AnyPgColumn => patient.id),

    /**
     * Why staff believe these are one person. Required, and deliberately free text: the
     * useful answer is "checked driver's licence at the desk", which no enum anticipates.
     *
     * Administrative justification written by staff, so it is recorded in the audit row's
     * `purpose` as well. It is not clinical content about the patient.
     */
    reason: text('reason').notNull(),

    /**
     * Exactly which rows moved, keyed by table: `{ appointment: [uuid, ...], ... }`.
     *
     * Ids and counts, never content. Reversal needs this because by then the surviving
     * chart may have acquired rows of its own, and "move back everything that is there"
     * would take those too.
     */
    manifest: jsonb('manifest').$type<Record<string, string[]>>().notNull(),

    performedBy: uuid('performed_by')
      .notNull()
      .references(() => userAccount.id),
    performedAt: timestamp('performed_at', { withTimezone: true }).notNull().defaultNow(),

    /* Reversal. The row is never deleted — an undone merge is itself history. */
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversedBy: uuid('reversed_by').references(() => userAccount.id),
    reversalReason: text('reversal_reason'),
  },
  (t) => [
    /**
     * A chart can be folded away once at a time.
     *
     * PARTIAL on `reversed_at is null`: a merge that was reversed must not block a later,
     * correct merge of the same chart — the first attempt being wrong is exactly when a
     * second one is needed.
     */
    uniqueIndex('patient_merge_duplicate_live_idx')
      .on(t.duplicatePatientId)
      .where(sql`${t.reversedAt} is null`),

    /** "What was folded into this chart", for the survivor's provenance panel. */
    index('patient_merge_surviving_idx').on(t.survivingPatientId, t.performedAt.desc()),

    /** A chart cannot be merged into itself. Cheap, and the mistake is easy to make. */
    check(
      'patient_merge_distinct',
      sql`${t.survivingPatientId} <> ${t.duplicatePatientId}`,
    ),
  ],
);
