# Cliniqo — Audit Logging

How every patient-data read and write gets recorded, and how later features must call it.

---

## The rule

**Patient data is reached only through `src/server/data-access/`.** Nothing else may
import `patient`, `appointment`, `visitNote`, `prescription`, or their siblings — ESLint
rejects it:

```
src/server/services/patients.ts
  2:10  error  'patient' import from '@/db/schema' is restricted. Patient tables may only
               be queried from src/server/data-access/...
```

That is the whole design in one sentence. The audit trail does not depend on anybody
remembering to write one, because there is no code path that reads a chart without
producing a log row.

---

## The helper API

Three functions, same machinery, different names so `grep` distinguishes them.

```ts
import { auditedRead, auditedWrite, auditedSearch } from '@/server/data-access';
```

### Reading a chart

```ts
export async function getPatientChart(patientId: string) {
  return auditedRead(
    {
      permission: 'patient.read.clinical',
      action: 'patient.read',
      entityType: 'patient',
      entityId: patientId,
      subjectPatientId: patientId,
      metadata: { fields: ['allergies', 'flags', 'notes'] },
    },
    async (tx) => {
      const [row] = await tx
        .select({/* narrow projection */})
        .from(patient)
        .where(eq(patient.id, patientId))
        .limit(1);
      return row ?? null;
    },
  );
}
```

Note `tx`, not `getDb()`. The callback receives the transaction, and using anything else
breaks the atomicity guarantee below.

### Writing

```ts
await auditedWrite(
  {
    permission: 'note.sign',
    action: 'note.sign',
    entityType: 'visit_note',
    entityId: noteId,
    subjectPatientId, // still required — the note belongs to a patient
    metadata: { versionNumber: 3 },
  },
  async (tx, session) => {
    /* ... */
  },
);
```

### Searching

```ts
return auditedSearch(
  { permission: 'patient.read.identifying', entityType: 'patient' },
  (tx) => tx.select({ /* ... */ }).from(patient).where(/* ... */).limit(25),
  (rows) => ({ resultCount: rows.length, resultIds: rows.map((r) => r.id }),
);
```

---

## What the spec fields mean

| Field              | Rule                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `permission`       | Checked _before_ any work runs. Refusal is itself audited, then throws.                                                                      |
| `action`           | A member of the closed union in `server/audit/actions.ts`. Never a string.                                                                   |
| `entityType`       | Which table. Constrained enum — `entity_id` carries no foreign key, so this is the only structural guarantee the reference is interpretable. |
| `entityId`         | The specific record, when there is one.                                                                                                      |
| `subjectPatientId` | **Whose PHI.** Required for every PHI action; a runtime assertion throws without it.                                                         |
| `purpose`          | Stated reason. Required for break-glass.                                                                                                     |
| `metadata`         | Field **names**, counts, filter names. **Never values.**                                                                                     |

### Why `subjectPatientId` is mandatory and asserted

Populate it even when `entityId` points at a note or a prescription rather than the
patient. It is the indexed column that turns the two questions carrying statutory
deadlines into single lookups:

- _"Who accessed this patient's record?"_ — §164.528, six years back.
- _"This account was compromised. Whose records did it touch?"_ — 60-day breach clock.

A PHI row logged without it is unqueryable by patient, which makes it useless for exactly
the moments the log exists for. The assertion throws rather than warns: a silent gap in
the trail is worse than a failed request.

### Why metadata never carries values

Record `{ fields: ['allergies'] }`, not `{ allergen: 'penicillin' }`. Record
`{ resultCount: 12 }`, not `{ query: 'HIV clinic' }` — a staff member's search string can
itself be a diagnosis.

An audit log containing PHI is a second copy of the database, with a six-year retention
requirement and weaker access controls than the original.

---

## Transaction semantics

Different by outcome, deliberately.

| Outcome     | Where the audit row is written       | Why                                                                                                           |
| ----------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **allowed** | Inside the operation's transaction   | Both commit or neither does. No phantom entry for rolled-back work; no committed read that went unlogged.     |
| **denied**  | Separate transaction                 | The operation never began, but the attempt did — and the attempt is the thing worth recording.                |
| **error**   | Separate transaction, after rollback | Same reasoning. Writing it inside the failed transaction would roll the evidence back along with the failure. |

Denials are logged as carefully as successes. `outcome = 'denied'` has its own partial
index because an attempted boundary violation is usually the first visible sign of a
compromised account, and a log that records only successes cannot show you someone
probing.

A failure to write an out-of-band audit row is logged and swallowed — it must never mask
the original error or turn a denial into a 500 that invites a retry.

---

## Immutability

Enforced in the database, not by application discipline. Three layers:

1. **Privileges.** The application role holds `INSERT` and `SELECT` on `audit_event` and
   nothing else.
2. **Trigger.** `cliniqo_audit_event_immutable()` raises on any `UPDATE` or `DELETE` —
   catching the schema owner too, not just the app role.
3. **Event trigger.** New monthly partitions are stripped of `UPDATE`/`DELETE` for the app
   role automatically; partition privileges are not inherited from the parent.

Verified against a live PostgreSQL 17 in an earlier session:

```
UPDATE audit_event ...                        ERROR: audit_event is append-only (attempted UPDATE)
DELETE FROM audit_event ...                   ERROR: audit_event is append-only (attempted DELETE)
UPDATE audit_event ...        (as app role)   ERROR: permission denied for table audit_event
ALTER TABLE audit_event DISABLE TRIGGER ...   ERROR: must be owner of table audit_event
```

Eventual purging, when state retention law finally permits it, is `DETACH PARTITION` then
`DROP` — DDL, which the trigger does not block, run by the owner.

---

## Checklist for a new feature

1. Put the query in `src/server/data-access/`. ESLint will not let you put it elsewhere.
2. Wrap it in `auditedRead` / `auditedWrite` / `auditedSearch`.
3. Pick the `permission` from `src/lib/permissions.ts`; add one there and to a migration
   if none fits. Do not reuse an approximate one.
4. Pick the `action` from `src/server/audit/actions.ts`; add one if none fits.
5. Always set `subjectPatientId`.
6. Put field names in `metadata`. Re-read them and confirm no value could be PHI.
7. Return a narrow projection to the caller, not the row.

---

## Known gaps

- **Reading the audit log is not itself audited.** "Who looked at who looked" matters, but
  a row per audit read creates an unbounded feedback loop when a viewer paginates. Phase 7
  should record one `audit.viewed` event per session instead.
- **Search granularity is a compliance judgement, not a settled fact.** One
  `patient.search` row carries a result count; the per-patient trail comes from the
  `patient.read` written when a chart is opened. A strict reading of §164.528 would write
  a row per result. `resultIds` is the hook if your compliance officer wants that.
- **Break-glass is modelled but not wired.** `break_glass_grant` and the `breakglass.use`
  action exist; the flow that issues a grant lands with the patient features.
