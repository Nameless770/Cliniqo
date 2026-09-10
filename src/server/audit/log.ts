import 'server-only';

import type { Db } from '@/db/client';
import type { AuditAction } from './actions';
import { auditEvent } from '@/db/schema';
import { uuidv7 } from '@/lib/uuidv7';

/**
 * Audit writer.
 *
 * Takes a transaction rather than opening its own, so the audit row and the operation it
 * describes commit together or not at all. A rolled-back operation leaves no phantom
 * entry, and a committed one cannot go unlogged.
 *
 * This is the seam the full audited-data-access layer will build on in phase 3b: that
 * layer will be the only code permitted to read patient tables, and it will call this on
 * every read. For now, auth events use it directly.
 */

/**
 * The transaction handle Drizzle hands to a `db.transaction(...)` callback.
 *
 * Derived from the real database type rather than hand-written, so it cannot drift from
 * what callers actually pass. Accepting the full handle (not just `insert`) keeps the
 * door open for the data-access layer to read inside the same transaction.
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type AuditEntityType =
  | 'patient'
  | 'patient_allergy'
  | 'patient_flag'
  | 'appointment'
  | 'visit_note'
  | 'visit_note_version'
  | 'prescription'
  | 'prescription_item'
  | 'user_account'
  | 'user_role'
  | 'session'
  | 'patient_account'
  | 'patient_session'
  | 'clinic'
  | 'break_glass_grant'
  | 'triage_conversation'
  | 'triage_message'
  | 'audit_event';

export type AuditInput = {
  clinicId: string;
  actorUserId?: string | null;
  /** Set instead of actorUserId when the action came from a patient via the portal. */
  actorPatientAccountId?: string | null;
  /** Roles held AT THIS MOMENT. A snapshot, because grants change and the log must not lie. */
  actorRoleCodes?: string[] | null;
  actorIp?: string | null;
  actorUserAgent?: string | null;
  sessionId?: string | null;
  /**
   * A member of the closed action union. Not a string: free-text actions drift across
   * pull requests until "who accessed this record" is no longer answerable by query.
   */
  action: AuditAction;
  outcome: 'allowed' | 'denied' | 'error';
  /**
   * Whose PHI was touched. Populate on EVERY event that touches patient data, even when
   * `entityId` points at a note or a prescription — this column is what answers
   * "who accessed this patient's record" (§164.528) and "whose records did this
   * compromised account touch" (60-day breach clock) as single-index lookups.
   */
  subjectPatientId?: string | null;
  entityType?: AuditEntityType | null;
  entityId?: string | null;
  purpose?: string | null;
  breakGlassGrantId?: string | null;
  requestId?: string | null;
  /**
   * Field NAMES and result counts only.
   *
   * Never field values, search terms, or note content. An audit log carrying PHI is a
   * second copy of the database with a six-year retention requirement and weaker access
   * controls than the original.
   */
  metadata?: Record<string, unknown> | null;
};

export async function writeAuditEvent(tx: Tx, input: AuditInput): Promise<void> {
  await tx.insert(auditEvent).values({
    // Supplied here, not defaulted in the database: v7 is time-ordered, which keeps
    // inserts on this very hot table at the right-hand edge of the index.
    id: uuidv7(),
    occurredAt: new Date(),
    clinicId: input.clinicId,
    actorUserId: input.actorUserId ?? null,
    actorPatientAccountId: input.actorPatientAccountId ?? null,
    actorRoleCodes: input.actorRoleCodes ?? null,
    actorIp: input.actorIp ?? null,
    actorUserAgent: input.actorUserAgent ?? null,
    sessionId: input.sessionId ?? null,
    action: input.action,
    outcome: input.outcome,
    subjectPatientId: input.subjectPatientId ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    purpose: input.purpose ?? null,
    breakGlassGrantId: input.breakGlassGrantId ?? null,
    requestId: input.requestId ?? null,
    metadata: input.metadata ?? null,
  });
}
