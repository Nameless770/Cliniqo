'use client';

import { useActionState, useState } from 'react';

import { Badge, Button, Field, Input, Textarea } from '@/components/ui';
import { mergePatientsAction, type MergeFormState } from '@/server/actions/patient-merge';

/**
 * Pick a duplicate and fold it into this chart.
 *
 * The shape of this form is the safety argument. A merge is not undoable by pressing
 * back — it moves clinical rows between records, and if the two charts turn out to be two
 * people it has combined their histories. So:
 *
 *   - the candidate is CHOSEN, never defaulted. Nothing is pre-selected, because a
 *     pre-selected radio is one keystroke from a merge nobody read;
 *   - the direction is stated in words on the button itself, not inferred from which
 *     column a row is in;
 *   - a reason is required, and it is the thing an auditor reads a year later;
 *   - "MERGE" is typed out. Not a control — `patient.merge` is the control, re-checked
 *     server-side — but a deliberate pause in front of an action that is expensive to
 *     undo.
 *
 * No PHI arrives here beyond what the page already renders: name, MRN, date of birth.
 */

export type Candidate = {
  id: string;
  mrn: string;
  name: string;
  dateOfBirth: string;
  selfRegistered: boolean;
  identityVerified: boolean;
  archived: boolean;
};

export function MergeForm({
  survivingPatientId,
  survivingName,
  survivingMrn,
  candidates,
}: {
  survivingPatientId: string;
  survivingName: string;
  survivingMrn: string;
  candidates: Candidate[];
}) {
  const [state, action, pending] = useActionState<MergeFormState, FormData>(
    mergePatientsAction,
    {},
  );
  const [chosen, setChosen] = useState<string | null>(null);

  const selected = candidates.find((c) => c.id === chosen) ?? null;

  return (
    <form action={action} style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <input type="hidden" name="survivingPatientId" value={survivingPatientId} />

      <fieldset
        style={{
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--space-3)',
          margin: 0,
        }}
      >
        <legend style={{ padding: '0 var(--space-2)', fontSize: 'var(--text-sm)' }}>
          Which chart is the duplicate?
        </legend>

        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          {candidates.map((candidate) => (
            <label
              key={candidate.id}
              style={{
                display: 'flex',
                gap: 'var(--space-3)',
                alignItems: 'baseline',
                padding: 'var(--space-2)',
                borderRadius: 'var(--radius-sm)',
                background: chosen === candidate.id ? 'var(--bg-sunken)' : 'transparent',
                cursor: 'pointer',
              }}
            >
              <input
                type="radio"
                name="duplicatePatientId"
                value={candidate.id}
                checked={chosen === candidate.id}
                onChange={() => setChosen(candidate.id)}
              />
              <span style={{ display: 'grid', gap: 'var(--space-1)' }}>
                <span style={{ fontWeight: 500 }}>{candidate.name}</span>
                <span
                  style={{
                    fontSize: 'var(--text-sm)',
                    color: 'var(--text-secondary)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {candidate.mrn} · born {candidate.dateOfBirth}
                </span>
                <span style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  {candidate.selfRegistered ? (
                    <Badge tone={candidate.identityVerified ? 'neutral' : 'warning'}>
                      {candidate.identityVerified
                        ? 'registered online · ID checked'
                        : 'registered online · identity not yet checked'}
                    </Badge>
                  ) : null}
                  {candidate.archived ? <Badge tone="neutral">archived</Badge> : null}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {selected ? (
        <p
          style={{
            margin: 0,
            padding: 'var(--space-3)',
            background: 'var(--bg-sunken)',
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--text-sm)',
          }}
        >
          Everything on <strong>{selected.name}</strong> ({selected.mrn}) — appointments,
          notes, prescriptions, allergies, flags, invoices and triage — moves to{' '}
          <strong>{survivingName}</strong> ({survivingMrn}). The duplicate keeps its MRN,
          is archived, and points here. The audit trail of both charts stays where it is.
        </p>
      ) : null}

      <Field
        id="merge-reason"
        label="How did you confirm these are the same person?"
        error={state.errors?.['reason']?.[0]}
        hint="Recorded on both charts' audit trail. An auditor reads this, not the click."
      >
        <Textarea
          id="merge-reason"
          name="reason"
          rows={2}
          placeholder="e.g. Checked driver's licence at the front desk on 15 Sept."
        />
      </Field>

      <Field
        id="merge-confirm"
        label="Type MERGE to confirm"
        error={state.errors?.['confirm']?.[0]}
      >
        <Input id="merge-confirm" name="confirm" autoComplete="off" />
      </Field>

      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
        <Button type="submit" variant="danger" loading={pending} disabled={!chosen}>
          Merge into {survivingMrn}
        </Button>
        {state.message ? (
          <span
            role="alert"
            style={{ fontSize: 'var(--text-sm)', color: 'var(--status-danger-text)' }}
          >
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}
