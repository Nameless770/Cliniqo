'use client';

import { useActionState } from 'react';

import { Button, Field, Input, Select, Textarea } from '@/components/ui';
import { ROUTES } from '@/lib/prescription-schemas';
import {
  correctPrescriptionAction,
  createPrescriptionAction,
  type PrescriptionFormState,
} from '@/server/actions/prescriptions';

/**
 * Prescribing form.
 *
 * Receives the formulary (reference data, not PHI) and ids. No patient record crosses
 * this boundary.
 *
 * In `correct` mode the fields are pre-filled from the prescription being replaced, so
 * the clinician edits a copy — but submitting issues a NEW prescription and cancels the
 * old one. Nothing is edited in place, and the form says so.
 */
export function PrescribeForm({
  patientId,
  visitNoteId,
  formulary,
  correcting,
}: {
  patientId: string;
  visitNoteId?: string;
  formulary: {
    id: string;
    name: string;
    strength: string | null;
    isControlled: boolean;
  }[];
  correcting?: {
    originalId: string;
    defaults: Partial<Record<string, string | number>>;
  };
}) {
  const action = correcting ? correctPrescriptionAction : createPrescriptionAction;
  const [state, formAction, pending] = useActionState<PrescriptionFormState, FormData>(
    action,
    {},
  );

  const err = (f: string) => state.errors?.[f]?.[0];
  const d = correcting?.defaults ?? {};

  if (state.ok) {
    return (
      <p
        role="status"
        style={{
          padding: 'var(--space-3) var(--space-4)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--status-success-bg)',
          color: 'var(--status-success-text)',
          fontSize: 'var(--text-sm)',
        }}
      >
        {state.message} <a href={`/patients/${patientId}`}>Back to patient</a>.
      </p>
    );
  }

  return (
    <form action={formAction} style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <input type="hidden" name="patientId" value={patientId} />
      {visitNoteId ? (
        <input type="hidden" name="visitNoteId" value={visitNoteId} />
      ) : null}
      {correcting ? (
        <input
          type="hidden"
          name="originalPrescriptionId"
          value={correcting.originalId}
        />
      ) : null}

      {state.message ? (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--status-danger-bg)',
            color: 'var(--status-danger-text)',
            fontSize: 'var(--text-sm)',
          }}
        >
          {state.message}
        </p>
      ) : null}

      {correcting ? (
        <p
          style={{
            margin: 0,
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--status-info-bg)',
            color: 'var(--status-info-text)',
            fontSize: 'var(--text-sm)',
          }}
        >
          Issuing a correction{' '}
          <strong>cancels the original and creates a new prescription</strong> that
          references it. The original stays in the record with your reason attached —
          nothing is edited or removed.
        </p>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(13rem, 1fr))',
          gap: 'var(--space-4)',
        }}
      >
        <Field id="medicationId" label="Medication" required error={err('medicationId')}>
          <Select name="medicationId" defaultValue={String(d['medicationId'] ?? '')}>
            <option value="">Choose…</option>
            {formulary.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.isControlled ? ' — controlled, cannot be prescribed here' : ''}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          id="dose"
          label="Dose"
          required
          hint="e.g. 500 mg, 2 puffs"
          error={err('dose')}
        >
          <Input name="dose" defaultValue={String(d['dose'] ?? '')} />
        </Field>

        <Field id="route" label="Route" required error={err('route')}>
          <Select name="route" defaultValue={String(d['route'] ?? 'oral')}>
            {ROUTES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          id="frequency"
          label="Frequency"
          required
          hint="e.g. three times daily"
          error={err('frequency')}
        >
          <Input name="frequency" defaultValue={String(d['frequency'] ?? '')} />
        </Field>

        <Field
          id="durationDays"
          label="Duration (days)"
          required
          error={err('durationDays')}
        >
          <Input
            name="durationDays"
            type="number"
            min={1}
            max={365}
            defaultValue={String(d['durationDays'] ?? '7')}
          />
        </Field>

        <Field id="quantity" label="Quantity" required error={err('quantity')}>
          <Input
            name="quantity"
            type="number"
            step="0.01"
            min={0.01}
            defaultValue={String(d['quantity'] ?? '')}
          />
        </Field>

        <Field
          id="quantityUnit"
          label="Quantity unit"
          required
          hint="tablets, ml, inhalers"
          error={err('quantityUnit')}
        >
          <Input name="quantityUnit" defaultValue={String(d['quantityUnit'] ?? '')} />
        </Field>

        <Field id="refills" label="Refills" error={err('refills')}>
          <Input
            name="refills"
            type="number"
            min={0}
            max={11}
            defaultValue={String(d['refills'] ?? '0')}
          />
        </Field>
      </div>

      <Field
        id="instructions"
        label="Directions for the patient"
        hint="The sig — printed on the prescription"
        error={err('instructions')}
      >
        <Textarea
          name="instructions"
          rows={2}
          defaultValue={String(d['instructions'] ?? '')}
        />
      </Field>

      <Field
        id="indication"
        label="Indication"
        hint="Why this is being prescribed"
        error={err('indication')}
      >
        <Input name="indication" defaultValue={String(d['indication'] ?? '')} />
      </Field>

      {correcting ? (
        <Field
          id="reason"
          label="Reason for the correction"
          required
          hint="Recorded against the cancelled original"
          error={err('reason')}
        >
          <Input name="reason" />
        </Field>
      ) : null}

      <div>
        <Button type="submit" variant="primary" size="lg" loading={pending}>
          {pending
            ? 'Issuing'
            : correcting
              ? 'Cancel original and issue correction'
              : 'Issue prescription'}
        </Button>
      </div>

      <p
        style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}
      >
        A prescription is issued immediately and cannot be edited afterwards. Corrections
        create a new entry that references this one.
      </p>
    </form>
  );
}
