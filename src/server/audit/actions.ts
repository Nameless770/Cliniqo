import 'server-only';

/**
 * The audit action taxonomy.
 *
 * A closed union, not free text. Free-text actions drift — `patient.read` becomes
 * `patient.view` becomes `read_patient` across three pull requests — and once they have,
 * the question "who accessed this record" can no longer be answered by a query. That
 * question carries a 60-day statutory deadline, so the vocabulary is fixed here and
 * type-checked at every call site.
 *
 * Cardinality matters too. Actions are a dimension you GROUP BY, so nothing dynamic goes
 * in them: a denied permission is `authz.denied` with the permission in `metadata`, never
 * `authz.denied:patient.read.clinical`. Interpolating a value into the action name
 * produces an unbounded set of distinct actions and an unusable index.
 */
export const AUDIT_ACTIONS = [
  /* Authentication. Not PHI access, but the trail that explains every later row. */
  'auth.login',
  'auth.logout',
  'auth.password_change',
  'session.revoke',

  /* Authorization refusals. The first visible sign of a compromised account. */
  'authz.denied',

  /* Patient records. `search` and `read` are separate: a list of results and an opened
     chart are different disclosures and are answered differently under §164.528. */
  'patient.search',
  'patient.read',
  'patient.create',
  'patient.update',
  'patient.archive',
  /* A full-record disclosure to the patient (§164.524). */
  'patient.export',

  'allergy.read',
  'allergy.create',
  'allergy.update',
  'flag.read',
  'flag.create',
  'flag.update',

  'appointment.read',
  /* A schedule window spans many patients — see COLLECTION_ACTIONS below. */
  'appointment.search',
  'appointment.create',
  'appointment.update',
  'appointment.cancel',
  'appointment.checkin',

  'note.read',
  'note.create',
  'note.update',
  'note.sign',
  'note.amend',

  'prescription.read',
  'prescription.create',
  'prescription.cancel',

  /* Administration. */
  'staff.read',
  'staff.create',
  'staff.update',
  'role.assign',
  'audit.read',
  /* Producing a §164.528 accounting for a patient. */
  'disclosure.accounting',
  'clinic.configure',
  /* Non-PHI reference data: staff names, appointment types, clinic config. */
  'reference.read',

  /* Emergency access — §164.312(a)(2)(ii). */
  'breakglass.grant',
  'breakglass.use',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Actions that constitute access to protected health information.
 *
 * Used by the data-access layer to assert that `subjectPatientId` is populated. An
 * unattributed PHI read is a row that cannot answer "whose data was this", which is the
 * only question that matters when the breach clock is running.
 */
export const PHI_ACTIONS: ReadonlySet<AuditAction> = new Set([
  'patient.search',
  'patient.read',
  'patient.create',
  'patient.update',
  'patient.archive',
  'patient.export',
  'allergy.read',
  'allergy.create',
  'allergy.update',
  'flag.read',
  'flag.create',
  'flag.update',
  'appointment.read',
  'appointment.search',
  'appointment.create',
  'appointment.update',
  'appointment.cancel',
  'appointment.checkin',
  'note.read',
  'note.create',
  'note.update',
  'note.sign',
  'note.amend',
  'prescription.read',
  'prescription.create',
  'prescription.cancel',
  'breakglass.use',
]);

/**
 * Reads that legitimately span MANY patients: a search, a schedule window.
 *
 * Exempt from the `subjectPatientId` requirement, because there is no single subject to
 * name. They are still PHI actions and still audited — with a result count, never the
 * query — and the individually-attributable trail comes from the single-record read that
 * follows when someone opens one.
 *
 * A set rather than a hardcoded action name in the assertion: the first version special-
 * cased 'patient.search' by string, which silently failed the moment a second collection
 * read existed.
 */
export const COLLECTION_ACTIONS: ReadonlySet<AuditAction> = new Set([
  'patient.search',
  'appointment.search',
]);
