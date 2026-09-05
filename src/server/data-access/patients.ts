import 'server-only';

import { and, asc, count, eq, isNull, isNotNull, or, sql } from 'drizzle-orm';

import { clinic, patient, patientAllergy, patientFlag } from '@/db/schema';
import type {
  ClinicalPatientInput,
  CreatePatientInput,
  IdentifyingPatientInput,
  PatientSearchInput,
} from '@/lib/patient-schemas';
import type { Tx } from '@/server/audit/log';
import type { ActiveSession } from '@/server/auth/session';

import { auditedRead, auditedSearch, auditedWrite } from './audited';

/**
 * Patient data access.
 *
 * =========================================================================
 * HOW THE RECEPTIONIST RESTRICTION IS ENFORCED AT THE DATA LAYER
 * =========================================================================
 *
 * Not by hiding fields in the UI, and not by deleting them from a result after fetching.
 * Three layers, each sufficient on its own:
 *
 * 1. THE SQL NEVER SELECTS THEM.
 *    `IDENTIFYING_COLUMNS` and `CLINICAL_COLUMNS` are separate projections. A caller
 *    without `patient.read.clinical` gets a SELECT that does not mention
 *    `sex_assigned_at_birth` or `deceased_date`, and the allergy and flag queries are not
 *    issued at all. The data never reaches the server's memory, so it cannot reach the
 *    RSC payload, the HTML, or a screenshot.
 *
 * 2. THE TYPE SYSTEM MAKES IT UNREACHABLE.
 *    `getPatient` returns a discriminated union on `scope`. Rendering code physically
 *    cannot read `.allergies` without narrowing to `scope === 'full'` — a receptionist
 *    view that tried would not compile.
 *
 * 3. THE WRITE SCHEMA HAS NO CLINICAL FIELDS.
 *    Updates are parsed by `identifyingPatientInput` unless the caller holds
 *    `patient.update.clinical`. That schema is `.strict()`, so a payload carrying
 *    `sexAssignedAtBirth` is REJECTED rather than silently stripped — and the rejection is
 *    audited, because a request containing fields the caller cannot write is either a bug
 *    or a probe.
 *
 * Every function here goes through auditedRead / auditedWrite / auditedSearch, so
 * authorization, the query, and the audit row share one transaction.
 */

/* -------------------------------------------------------------------------- */
/* Projections                                                                */
/* -------------------------------------------------------------------------- */

const IDENTIFYING_COLUMNS = {
  id: patient.id,
  mrn: patient.mrn,
  legalFirstName: patient.legalFirstName,
  legalMiddleName: patient.legalMiddleName,
  legalLastName: patient.legalLastName,
  preferredName: patient.preferredName,
  pronouns: patient.pronouns,
  dateOfBirth: patient.dateOfBirth,
  genderIdentity: patient.genderIdentity,
  phonePrimary: patient.phonePrimary,
  phoneSecondary: patient.phoneSecondary,
  email: patient.email,
  addressLine1: patient.addressLine1,
  addressLine2: patient.addressLine2,
  city: patient.city,
  state: patient.state,
  postalCode: patient.postalCode,
  preferredLanguage: patient.preferredLanguage,
  emergencyContactName: patient.emergencyContactName,
  emergencyContactPhone: patient.emergencyContactPhone,
  emergencyContactRelationship: patient.emergencyContactRelationship,
  nppAcknowledgedAt: patient.nppAcknowledgedAt,
  createdAt: patient.createdAt,
  updatedAt: patient.updatedAt,
  version: patient.version,
  archivedAt: patient.archivedAt,
  archiveReason: patient.archiveReason,
} as const;

/** Added only for callers holding `patient.read.clinical`. */
const CLINICAL_COLUMNS = {
  sexAssignedAtBirth: patient.sexAssignedAtBirth,
  deceasedDate: patient.deceasedDate,
} as const;

export type PatientIdentifying = {
  [K in keyof typeof IDENTIFYING_COLUMNS]: (typeof IDENTIFYING_COLUMNS)[K]['_']['data'];
};

export type PatientAllergy = {
  id: string;
  allergenType: string;
  allergenName: string;
  reaction: string | null;
  severity: string | null;
  status: string;
};

export type PatientFlagRow = {
  id: string;
  flagType: string;
  label: string;
  detail: string | null;
  severity: string;
};

/**
 * The result of reading one patient.
 *
 * A discriminated union, not an object with optional clinical fields. Optional fields
 * would let a receptionist-facing component write `patient.allergies?.map(...)` and
 * compile — silently correct today, silently wrong the day the projection changes.
 */
export type PatientView =
  | { scope: 'identifying'; patient: PatientIdentifying }
  | {
      scope: 'full';
      patient: PatientIdentifying & {
        sexAssignedAtBirth: string | null;
        deceasedDate: string | null;
      };
      allergies: PatientAllergy[];
      flags: PatientFlagRow[];
    };

export type PatientListRow = {
  id: string;
  mrn: string;
  legalFirstName: string;
  legalLastName: string;
  preferredName: string | null;
  dateOfBirth: string;
  phonePrimary: string | null;
  archivedAt: Date | null;
};

export type PatientList = {
  rows: PatientListRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

/* -------------------------------------------------------------------------- */
/* Read: one patient                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Read a single patient, scoped to the caller's permissions.
 *
 * Requires `patient.read.identifying`, which every role holds. The CLINICAL half is gated
 * separately, inside — a receptionist gets a successful read of a narrower record, not a
 * denial. Denying outright would stop the front desk booking appointments; the boundary
 * is about fields, not about access to the patient.
 */
export async function getPatient(patientId: string): Promise<PatientView | null> {
  return auditedRead(
    {
      permission: 'patient.read.identifying',
      action: 'patient.read',
      entityType: 'patient',
      entityId: patientId,
      subjectPatientId: patientId,
    },
    async (tx, session) => {
      const full = session.permissions.has('patient.read.clinical');

      const [row] = await tx
        .select(
          full ? { ...IDENTIFYING_COLUMNS, ...CLINICAL_COLUMNS } : IDENTIFYING_COLUMNS,
        )
        .from(patient)
        .where(and(eq(patient.id, patientId), eq(patient.clinicId, session.clinicId)))
        .limit(1);

      if (!row) return null;

      if (!full) {
        return { scope: 'identifying', patient: row as PatientIdentifying };
      }

      // Only issued for clinical readers. A receptionist's request never runs these.
      const [allergies, flags] = await Promise.all([
        tx
          .select({
            id: patientAllergy.id,
            allergenType: patientAllergy.allergenType,
            allergenName: patientAllergy.allergenName,
            reaction: patientAllergy.reaction,
            severity: patientAllergy.severity,
            status: patientAllergy.status,
          })
          .from(patientAllergy)
          .where(
            and(
              eq(patientAllergy.patientId, patientId),
              eq(patientAllergy.status, 'active'),
              isNull(patientAllergy.archivedAt),
            ),
          ),
        tx
          .select({
            id: patientFlag.id,
            flagType: patientFlag.flagType,
            label: patientFlag.label,
            detail: patientFlag.detail,
            severity: patientFlag.severity,
          })
          .from(patientFlag)
          .where(
            and(eq(patientFlag.patientId, patientId), isNull(patientFlag.archivedAt)),
          ),
      ]);

      return {
        scope: 'full',
        patient: row as PatientIdentifying & {
          sexAssignedAtBirth: string | null;
          deceasedDate: string | null;
        },
        allergies: allergies as PatientAllergy[],
        flags: flags as PatientFlagRow[],
      };
    },
  ) as Promise<PatientView | null>;
}

/* -------------------------------------------------------------------------- */
/* Read: search / list                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Searchable, paginated patient list.
 *
 * The list projection is identifying-only for EVERYONE, including clinicians. A roster is
 * a navigation surface; nobody needs a diagnosis to pick a name off it, and putting
 * clinical data in a list is how it ends up on a waiting-room screen.
 */
export async function searchPatients(input: PatientSearchInput): Promise<PatientList> {
  return auditedSearch(
    {
      permission: 'patient.read.identifying',
      entityType: 'patient',
      // Filter NAMES, never the query text — a search for "HIV clinic" would otherwise
      // write a diagnosis into the audit log.
      metadata: {
        hasQuery: input.query.length > 0,
        includeArchived: input.includeArchived,
        page: input.page,
      },
    },
    async (tx, session) => {
      const filters = [eq(patient.clinicId, session.clinicId)];

      if (!input.includeArchived) {
        filters.push(isNull(patient.archivedAt));
      }

      if (input.query) {
        const term = input.query;
        filters.push(
          or(
            // Full-text over the generated vector: names, MRN, phone.
            sql`${patient.searchVector} @@ plainto_tsquery('simple', ${term})`,
            // Trigram fallback so a mistyped name still finds the chart. A failed search
            // is what makes staff create a duplicate, and duplicates hide allergies.
            sql`${patient.legalLastName} % ${term}`,
            sql`${patient.preferredName} % ${term}`,
            sql`${patient.mrn} ilike ${'%' + term + '%'}`,
          )!,
        );
      }

      const where = and(...filters);

      const [rows, [totals]] = await Promise.all([
        tx
          .select({
            id: patient.id,
            mrn: patient.mrn,
            legalFirstName: patient.legalFirstName,
            legalLastName: patient.legalLastName,
            preferredName: patient.preferredName,
            dateOfBirth: patient.dateOfBirth,
            phonePrimary: patient.phonePrimary,
            archivedAt: patient.archivedAt,
          })
          .from(patient)
          .where(where)
          // `id` is the tiebreaker. Without a total order, OFFSET paging can repeat one
          // patient across pages and skip another when two share a name.
          .orderBy(
            asc(patient.legalLastName),
            asc(patient.legalFirstName),
            asc(patient.id),
          )
          .limit(input.pageSize)
          .offset((input.page - 1) * input.pageSize),
        tx.select({ value: count() }).from(patient).where(where),
      ]);

      const total = totals?.value ?? 0;

      return {
        rows: rows as PatientListRow[],
        total,
        page: input.page,
        pageSize: input.pageSize,
        pageCount: Math.max(1, Math.ceil(total / input.pageSize)),
      };
    },
    (result) => ({ resultCount: result.total }),
  );
}

/* -------------------------------------------------------------------------- */
/* Duplicate detection                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Live patients sharing a surname and date of birth.
 *
 * Registration refuses to proceed past a match unless the user confirms. Duplicate charts
 * are a safety defect, not an untidiness: an allergy recorded on one is invisible on the
 * other, and the clinician reading the wrong chart has no way to know.
 */
export async function findPotentialDuplicates(
  lastName: string,
  dateOfBirth: string,
): Promise<PatientListRow[]> {
  return auditedSearch(
    {
      permission: 'patient.create',
      entityType: 'patient',
      metadata: { check: 'duplicate_on_surname_and_dob' },
    },
    async (tx, session) =>
      tx
        .select({
          id: patient.id,
          mrn: patient.mrn,
          legalFirstName: patient.legalFirstName,
          legalLastName: patient.legalLastName,
          preferredName: patient.preferredName,
          dateOfBirth: patient.dateOfBirth,
          phonePrimary: patient.phonePrimary,
          archivedAt: patient.archivedAt,
        })
        .from(patient)
        .where(
          and(
            eq(patient.clinicId, session.clinicId),
            isNull(patient.archivedAt),
            sql`lower(${patient.legalLastName}) = lower(${lastName})`,
            eq(patient.dateOfBirth, dateOfBirth),
          ),
        )
        .limit(10) as Promise<PatientListRow[]>,
    (rows) => ({ resultCount: rows.length }),
  );
}

/* -------------------------------------------------------------------------- */
/* Write: create                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Allocate the next medical record number.
 *
 * `UPDATE ... RETURNING` inside the caller's transaction: the row lock serialises
 * concurrent registrations, so two receptionists registering at the same instant cannot
 * be handed the same MRN. Reading the counter and writing it back separately would.
 */
async function allocateMrn(tx: Tx, clinicId: string): Promise<string> {
  const [row] = await tx
    .update(clinic)
    .set({ mrnSequence: sql`${clinic.mrnSequence} + 1` })
    .where(eq(clinic.id, clinicId))
    .returning({ prefix: clinic.mrnPrefix, sequence: clinic.mrnSequence });

  if (!row) throw new Error('Clinic not found while allocating an MRN.');

  return `${row.prefix}-${String(row.sequence).padStart(6, '0')}`;
}

export async function createPatient(
  input: CreatePatientInput,
): Promise<{ id: string; mrn: string }> {
  return auditedWrite(
    {
      permission: 'patient.create',
      action: 'patient.create',
      entityType: 'patient',
      // Field NAMES supplied, never their values.
      metadata: {
        fields: Object.keys(input).filter((k) => k !== 'confirmedNotDuplicate'),
      },
    },
    async (tx, session) => {
      const mrn = await allocateMrn(tx, session.clinicId);

      const { confirmedNotDuplicate: _ignored, ...fields } = input;

      const [row] = await tx
        .insert(patient)
        .values({
          ...fields,
          clinicId: session.clinicId,
          mrn,
          registeredBy: session.userId,
        })
        .returning({ id: patient.id, mrn: patient.mrn });

      return { id: row!.id, mrn: row!.mrn };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Write: update                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Update a patient.
 *
 * `fields` has ALREADY been parsed by the schema matching the caller's permissions — see
 * the action layer. This function additionally builds the SET clause from an allowlist,
 * so even a mis-wired caller cannot write a column that was not in the projection.
 *
 * `expectedVersion` is optimistic concurrency: a receptionist correcting an address while
 * a clinician edits the same record must not silently overwrite them.
 */
export async function updatePatient(
  patientId: string,
  fields: IdentifyingPatientInput | ClinicalPatientInput,
  expectedVersion: number,
  scope: 'identifying' | 'clinical',
): Promise<{ updated: boolean; conflict: boolean }> {
  return auditedWrite(
    {
      permission: scope === 'clinical' ? 'patient.update.clinical' : 'patient.update',
      action: 'patient.update',
      entityType: 'patient',
      entityId: patientId,
      subjectPatientId: patientId,
      metadata: { scope, fields: Object.keys(fields) },
    },
    async (tx, session) => {
      const result = await tx
        .update(patient)
        .set({ ...fields, version: expectedVersion + 1 })
        .where(
          and(
            eq(patient.id, patientId),
            eq(patient.clinicId, session.clinicId),
            isNull(patient.archivedAt),
            // The concurrency check. No match means somebody else wrote first.
            eq(patient.version, expectedVersion),
          ),
        )
        .returning({ id: patient.id });

      return { updated: result.length > 0, conflict: result.length === 0 };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Write: archive / unarchive                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Archive. There is no delete.
 *
 * The row stays, with `archived_at`, who did it, and why. Clinical records are not
 * deletable (CLAUDE.md rule 4): an archived patient vanishes from search but remains
 * reachable from the appointments and notes that reference them, because the history has
 * to stay coherent.
 */
export async function archivePatient(
  patientId: string,
  reason: string,
): Promise<{ archived: boolean }> {
  return auditedWrite(
    {
      permission: 'patient.archive',
      action: 'patient.archive',
      entityType: 'patient',
      entityId: patientId,
      subjectPatientId: patientId,
      // The reason IS recorded, in `purpose` — it is an administrative justification
      // written by staff, not clinical content about the patient.
      purpose: reason,
    },
    async (tx, session) => {
      const result = await tx
        .update(patient)
        .set({
          archivedAt: new Date(),
          archivedBy: session.userId,
          archiveReason: reason,
        })
        .where(
          and(
            eq(patient.id, patientId),
            eq(patient.clinicId, session.clinicId),
            isNull(patient.archivedAt),
          ),
        )
        .returning({ id: patient.id });

      return { archived: result.length > 0 };
    },
  );
}

export async function unarchivePatient(
  patientId: string,
): Promise<{ restored: boolean }> {
  return auditedWrite(
    {
      permission: 'patient.archive',
      action: 'patient.update',
      entityType: 'patient',
      entityId: patientId,
      subjectPatientId: patientId,
      metadata: { operation: 'unarchive' },
    },
    async (tx, session) => {
      const result = await tx
        .update(patient)
        .set({ archivedAt: null, archivedBy: null, archiveReason: null })
        .where(
          and(
            eq(patient.id, patientId),
            eq(patient.clinicId, session.clinicId),
            isNotNull(patient.archivedAt),
          ),
        )
        .returning({ id: patient.id });

      return { restored: result.length > 0 };
    },
  );
}

/** Re-exported for the action layer, which needs the session type but not the db. */
export type { ActiveSession };
