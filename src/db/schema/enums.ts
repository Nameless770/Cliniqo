/**
 * All PostgreSQL enum types, in one place.
 *
 * These are database-level enums rather than free text so that an invalid state is
 * rejected by the database, not merely by whichever code path happened to validate.
 *
 * Adding a value to a pg enum is an online operation (`ALTER TYPE ... ADD VALUE`).
 * Removing one is not — it requires a type swap — so err toward fewer, broader values.
 */

import { pgEnum } from 'drizzle-orm/pg-core';

// Relative, not aliased: drizzle-kit bundles this file with its own resolver and does
// not read tsconfig paths.
import { ROLE_CODES } from '../../lib/roles';

/* -------------------------------------------------------------------------- */
/* Identity and access                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The three MVP roles.
 *
 * This enum constrains which role rows may exist; it is NOT what authorization checks
 * read. Checks resolve permissions through role_permission, so adding a fourth role
 * later is a seed-data change rather than a hunt for `=== 'doctor'` across the codebase.
 */
export const roleCode = pgEnum('role_code', ROLE_CODES);

export const userStatus = pgEnum('user_status', ['active', 'suspended', 'deactivated']);

/**
 * Why a session ended. `role_change` and `deactivated` exist because permission changes
 * must take effect immediately — a deactivated employee must not keep access until
 * their token happens to expire.
 */
export const sessionRevokedReason = pgEnum('session_revoked_reason', [
  'logout',
  'idle_timeout',
  'absolute_timeout',
  'role_change',
  'deactivated',
  'admin_revoke',
]);

/* -------------------------------------------------------------------------- */
/* Patient                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Sex assigned at birth. Clinically load-bearing (reference ranges, screening
 * eligibility) and deliberately separate from `patient.gender_identity`, which is free
 * text because it is not an enumerable clinical variable.
 */
export const sexAssignedAtBirth = pgEnum('sex_assigned_at_birth', [
  'male',
  'female',
  'intersex',
  'unknown',
]);

export const allergenType = pgEnum('allergen_type', [
  'drug',
  'food',
  'environmental',
  'other',
]);

export const allergySeverity = pgEnum('allergy_severity', [
  'mild',
  'moderate',
  'severe',
  'life_threatening',
]);

/**
 * `entered_in_error` is how clinical systems retract mistaken data. It is not a delete:
 * the row stays, visibly marked, because "this was recorded and later retracted" is
 * itself part of the record.
 */
export const clinicalRecordStatus = pgEnum('clinical_record_status', [
  'active',
  'inactive',
  'entered_in_error',
]);

export const patientFlagType = pgEnum('patient_flag_type', [
  'clinical_alert',
  'infection_control',
  'fall_risk',
  'safeguarding',
  'other',
]);

export const flagSeverity = pgEnum('flag_severity', ['info', 'warning', 'critical']);

/* -------------------------------------------------------------------------- */
/* Scheduling                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `cancelled` and `no_show` are distinct states, and the partial exclusion constraint in
 * migration 0001 excludes both — otherwise a cancelled appointment would block its slot
 * forever.
 */
export const appointmentStatus = pgEnum('appointment_status', [
  'scheduled',
  'checked_in',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
]);

/** Clinic-wide closure vs. one provider's time off, in a single table. */
export const scheduleExceptionKind = pgEnum('schedule_exception_kind', [
  'closure',
  'time_off',
  'blocked',
]);

/* -------------------------------------------------------------------------- */
/* Clinical documentation                                                     */
/* -------------------------------------------------------------------------- */

export const visitNoteStatus = pgEnum('visit_note_status', [
  'draft',
  'signed',
  'amended',
]);

/**
 * A version is a mutable draft, a frozen signed version, or an addendum.
 *
 * After signing, nothing is ever updated — corrections append an addendum and the
 * original stays readable (§164.526).
 */
export const visitNoteVersionKind = pgEnum('visit_note_version_kind', [
  'draft',
  'signed',
  'addendum',
]);

/* -------------------------------------------------------------------------- */
/* Prescribing                                                                */
/* -------------------------------------------------------------------------- */

export const prescriptionStatus = pgEnum('prescription_status', [
  'draft',
  'signed',
  'printed',
  'cancelled',
]);

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

export const auditOutcome = pgEnum('audit_outcome', ['allowed', 'denied', 'error']);

/**
 * The object dimension of an audit event.
 *
 * A constrained enum rather than free text because `audit_event.entity_id` carries no
 * foreign key (it points at many tables — see the data model doc, §10), so this enum is
 * the only structural guarantee that the reference is interpretable.
 */
export const auditEntityType = pgEnum('audit_entity_type', [
  'patient',
  'patient_allergy',
  'patient_flag',
  'appointment',
  'visit_note',
  'visit_note_version',
  'prescription',
  'prescription_item',
  'user_account',
  'user_role',
  'session',
  'patient_account',
  'patient_session',
  'clinic',
  'break_glass_grant',
  'triage_conversation',
  'triage_message',
  /* Reading the audit log is itself an audited event, and its object is the log. */
  'audit_event',
]);

/**
 * Triage.
 *
 * `urgency` is ordered by how fast someone must be seen, and `emergency` exists as its
 * own value rather than as the top of a severity scale because it does not mean "book
 * sooner" — it means stop using this application and call an ambulance. Code that maps
 * urgency to a booking lead time must have no branch for it.
 */
export const triageUrgency = pgEnum('triage_urgency', [
  'emergency',
  'urgent',
  'routine',
  'self_care',
]);

export const triageStatus = pgEnum('triage_status', ['open', 'closed']);

/** Who wrote a turn. Never a clinician: nothing here is clinical advice. */
export const triageMessageRole = pgEnum('triage_message_role', ['patient', 'assistant']);

/**
 * How a maintenance run ended.
 *
 * `failed` is a first-class outcome rather than an absent row: a job that threw must leave
 * evidence that it tried, or a silent failure looks identical to a job that was never
 * scheduled — which is exactly how the prune function went two years without running.
 */
export const maintenanceOutcome = pgEnum('maintenance_outcome', ['succeeded', 'failed']);

export const breakGlassReviewOutcome = pgEnum('break_glass_review_outcome', [
  'pending',
  'justified',
  'not_justified',
]);
