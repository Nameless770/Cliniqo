import 'server-only';

import { getDb } from '@/db/client';
import type { Permission } from '@/lib/permissions';
import {
  COLLECTION_ACTIONS,
  PHI_ACTIONS,
  type AuditAction,
} from '@/server/audit/actions';
import { writeAuditEvent, type AuditEntityType, type Tx } from '@/server/audit/log';
import { requirePermission, type AuthzContext } from '@/server/auth/authorize';
import { requestMeta, safeInet, type ActiveSession } from '@/server/auth/session';

import { checkReadBudget, isCountedRead } from './read-budget';

/**
 * The audited data-access layer.
 *
 * THE ONLY CODE PERMITTED TO TOUCH PATIENT TABLES. Enforced by ESLint: importing
 * `patient`, `appointment`, `visitNote`, `prescription` and friends from anywhere else
 * under src/server or src/app is a lint error.
 *
 * The point is structural, not procedural. Every one of these functions authorizes, runs
 * the work, and writes the audit row — so "read PHI without logging it" stops being
 * something a developer can forget and becomes something the codebase has no path for.
 * Retrofitting that after the patient screens exist means revisiting every call site,
 * which is why it is built before the first row of PHI (requirements analysis, §7).
 *
 * TRANSACTION SEMANTICS, which differ by outcome on purpose:
 *
 *   allowed  — audit row is written INSIDE the operation's transaction. Both commit or
 *              neither does: no phantom log entry for work that rolled back, and no
 *              committed read that went unlogged.
 *
 *   denied   — separate transaction. The operation never began, but the attempt did, and
 *              the attempt is the thing worth recording.
 *
 *   error    — separate transaction, after the rollback. Same reasoning: the operation
 *              did not happen, the attempt did. Writing this inside the failed
 *              transaction would roll the evidence back with the failure.
 */

/* -------------------------------------------------------------------------- */

export type AuditedSpec = {
  /** Checked before any work runs. Denial is audited and throws. */
  permission: Permission;
  action: AuditAction;
  entityType: AuditEntityType;
  /** The specific record acted on, where there is one. */
  entityId?: string | null;
  /**
   * Whose PHI this concerns.
   *
   * Required for any action in PHI_ACTIONS — see the assertion below. Populate it even
   * when `entityId` points at a note or a prescription rather than the patient: this is
   * the indexed column that answers §164.528 accounting-of-disclosures and breach
   * scoping as a single lookup.
   */
  subjectPatientId?: string | null;
  /** Stated reason. Required for break-glass; otherwise the business justification. */
  purpose?: string | null;
  /**
   * Field NAMES accessed, result counts, filter names.
   *
   * NEVER values. Not a patient name, not a search term, not a diagnosis, not a note
   * body. An audit log carrying PHI is a second copy of the database with a six-year
   * retention requirement and weaker access controls than the original.
   */
  metadata?: Record<string, unknown>;
};

/**
 * Guards against the mistake this whole layer exists to prevent: a PHI operation logged
 * without saying whose PHI it was. Such a row is unqueryable by patient, which makes it
 * useless for exactly the two questions that carry legal deadlines.
 *
 * Thrown, not warned. A silent gap in the audit trail is worse than a failed request.
 */
function assertSubjectPresent(spec: AuditedSpec): void {
  if (
    PHI_ACTIONS.has(spec.action) &&
    !COLLECTION_ACTIONS.has(spec.action) &&
    !spec.subjectPatientId
  ) {
    throw new Error(
      `Audit misuse: "${spec.action}" touches PHI but no subjectPatientId was supplied. ` +
        `Every PHI event must be attributable to a patient.`,
    );
  }
}

async function actorContext(session: ActiveSession) {
  const { ip, userAgent } = await requestMeta();
  return {
    clinicId: session.clinicId,
    actorUserId: session.userId,
    actorRoleCodes: session.roles,
    actorIp: safeInet(ip),
    actorUserAgent: userAgent,
    sessionId: session.sessionId,
  };
}

/**
 * Refusal because the actor exhausted their PHI read budget.
 *
 * Thrown, not returned, so it cannot be ignored by a caller — and recorded as a denial so
 * a scrape is visible in the audit log as a wall of refusals rather than a silent stop.
 */
export class ReadBudgetExceededError extends Error {
  constructor() {
    super('Too many record lookups in a short period.');
    this.name = 'ReadBudgetExceededError';
  }
}

/** Log an attempt that did not commit — an error, out of band from the rollback. */
async function auditOutOfBand(
  session: ActiveSession,
  spec: AuditedSpec,
  outcome: 'error',
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    const actor = await actorContext(session);
    await getDb().transaction(async (tx) => {
      await writeAuditEvent(tx, {
        ...actor,
        action: spec.action,
        outcome,
        subjectPatientId: spec.subjectPatientId ?? null,
        entityType: spec.entityType,
        entityId: spec.entityId ?? null,
        purpose: spec.purpose ?? null,
        metadata: { ...spec.metadata, ...extra },
      });
    });
  } catch (error) {
    // Never mask the original failure with a logging failure.
    console.error(
      '[audit] failed to record failed operation:',
      error instanceof Error ? error.message : 'unknown error',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Core                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Authorize, run, and audit — in that order, as one unit.
 *
 * `work` receives the transaction and the session. It MUST use the supplied `tx` rather
 * than reaching for `getDb()`, or the audit row and the data will not share a
 * transaction and the atomicity guarantee is gone.
 */
async function auditedOperation<T>(
  spec: AuditedSpec,
  work: (tx: Tx, session: ActiveSession) => Promise<T>,
  /**
   * Metadata only knowable after the work runs — a result count, how many fields came
   * back. Merged over `spec.metadata`.
   *
   * A callback rather than letting `work` mutate `spec`: the spec is spread into a new
   * object on the way in, so a mutation would silently never reach the audit row.
   */
  metadataFrom?: (result: T) => Record<string, unknown>,
): Promise<T> {
  assertSubjectPresent(spec);

  const context: AuthzContext = {
    subjectPatientId: spec.subjectPatientId ?? null,
    entityType: spec.entityType,
    entityId: spec.entityId ?? null,
    purpose: spec.purpose ?? null,
  };

  // Throws AuthorizationError on refusal, and records the denial itself.
  const session = await requirePermission(spec.permission, context);
  const actor = await actorContext(session);

  /*
   * F1: PHI read budget.
   *
   * After authorization, before the work. An authorised actor is exactly the threat this
   * addresses — the account is legitimate, the permission is real, and the volume is not.
   * Writes are not counted: a scrape reads, and throttling writes would block a clinic
   * mid-clinic for no exfiltration benefit.
   */
  if (isCountedRead(spec.action)) {
    const budget = await checkReadBudget(session.userId);

    if (!budget.allowed) {
      try {
        await getDb().transaction(async (tx) => {
          await writeAuditEvent(tx, {
            ...actor,
            action: spec.action,
            outcome: 'denied',
            subjectPatientId: spec.subjectPatientId ?? null,
            entityType: spec.entityType,
            entityId: spec.entityId ?? null,
            metadata: {
              reason: 'read_budget_exceeded',
              used: budget.used,
              limit: budget.limit,
              windowMinutes: budget.windowMinutes,
            },
          });
        });
      } catch (error) {
        console.error(
          '[audit] failed to record budget refusal:',
          error instanceof Error ? error.message : 'unknown error',
        );
      }

      throw new ReadBudgetExceededError();
    }
  }

  try {
    return await getDb().transaction(async (tx) => {
      const result = await work(tx, session);

      const metadata = {
        ...(spec.metadata ?? {}),
        ...(metadataFrom ? metadataFrom(result) : {}),
      };

      await writeAuditEvent(tx, {
        ...actor,
        action: spec.action,
        outcome: 'allowed',
        subjectPatientId: spec.subjectPatientId ?? null,
        entityType: spec.entityType,
        entityId: spec.entityId ?? null,
        purpose: spec.purpose ?? null,
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
      });

      return result;
    });
  } catch (error) {
    await auditOutOfBand(session, spec, 'error', {
      // The error's TYPE, never its message — a database error message can contain the
      // parameter values that caused it, and here those are patient data.
      errorKind: error instanceof Error ? error.name : 'unknown',
    });
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* The public API                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A read of patient data.
 *
 * Reads are audited, not just writes — §164.312(b) requires recording who *looked*, and
 * in practice inappropriate looking is the common violation, not inappropriate editing.
 *
 * ```ts
 * const chart = await auditedRead(
 *   {
 *     permission: 'patient.read.clinical',
 *     action: 'patient.read',
 *     entityType: 'patient',
 *     entityId: patientId,
 *     subjectPatientId: patientId,
 *     metadata: { fields: ['allergies', 'flags'] },
 *   },
 *   (tx) => tx.select(...).from(patient).where(eq(patient.id, patientId)),
 * );
 * ```
 */
export function auditedRead<T>(
  spec: AuditedSpec,
  work: (tx: Tx, session: ActiveSession) => Promise<T>,
): Promise<T> {
  return auditedOperation(spec, work);
}

/**
 * A write to patient data.
 *
 * Identical machinery to `auditedRead`; a separate name so that grepping the codebase
 * distinguishes reads from mutations without reading each call.
 */
export function auditedWrite<T>(
  spec: AuditedSpec,
  work: (tx: Tx, session: ActiveSession) => Promise<T>,
): Promise<T> {
  return auditedOperation(spec, work);
}

/**
 * A search across patients.
 *
 * Logged as ONE `patient.search` event carrying the result count, not one event per
 * matched patient.
 *
 * THIS IS A COMPLIANCE JUDGEMENT AND SHOULD BE RATIFIED, NOT INHERITED. A results list
 * showing names is arguably a disclosure of every patient in it, and the strict reading
 * of §164.528 would write a row per result. That would mean fifty audit rows for one
 * front-desk lookup, on the highest-insert table in the system.
 *
 * The position taken here: the search event records that a lookup happened and how many
 * records matched; opening a specific chart writes a per-patient `patient.read`, which is
 * where the individually-attributable trail comes from. If your compliance officer wants
 * per-result rows, `resultIds` below is the hook — pass them and fan out.
 */
export function auditedSearch<T>(
  spec: Omit<AuditedSpec, 'action' | 'subjectPatientId'> & {
    /** Must be a COLLECTION_ACTIONS member. Defaults to a patient search. */
    action?: AuditAction;
  },
  work: (tx: Tx, session: ActiveSession) => Promise<T>,
  /**
   * Counts and opaque ids only. NEVER the query string — a staff member searching
   * "HIV clinic" would otherwise write a diagnosis into the audit log, which is exactly
   * the leak this layer exists to prevent.
   */
  summarise?: (result: T) => {
    resultCount: number;
    resultIds?: string[];
    /**
     * Low-cardinality, non-PHI labels describing WHICH slice was returned — e.g. whether
     * a worklist came back scoped to one author or clinic-wide. Primitives only, and the
     * same prohibition applies as above: never the query, never a name, never a
     * diagnosis. It exists so a reviewer can tell a routine self-scoped read from a
     * broad one without re-running the query against today's data.
     */
    labels?: Record<string, string | number | boolean>;
  },
): Promise<T> {
  return auditedOperation(
    { ...spec, action: spec.action ?? 'patient.search' },
    work,
    summarise
      ? (result) => {
          const summary = summarise(result);
          return {
            resultCount: summary.resultCount,
            ...(summary.resultIds ? { resultIds: summary.resultIds } : {}),
            ...(summary.labels ?? {}),
          };
        }
      : undefined,
  );
}
