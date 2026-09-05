'use client';

import { useActionState, useState } from 'react';

import { Badge, Button, Field, Input, Select, Textarea } from '@/components/ui';
import {
  ALLERGEN_TYPES,
  ALLERGY_SEVERITIES,
  ALLERGY_SEVERITY_LABELS,
  FLAG_SEVERITIES,
  FLAG_TYPES,
  FLAG_TYPE_LABELS,
} from '@/lib/clinical-fact-schemas';
import {
  addAllergyAction,
  addFlagAction,
  endFlagAction,
  setAllergyStatusAction,
  type ClinicalFactState,
} from '@/server/actions/clinical-facts';

/**
 * Allergy and flag management.
 *
 * Rendered only for clinicians. That is presentation — the four actions behind it each
 * require `patient.update.clinical` server-side, so rendering this to the wrong role
 * would produce refusals, not writes.
 */

export type AllergyView = {
  id: string;
  allergenType: string;
  allergenName: string;
  reaction: string | null;
  severity: string | null;
  status: string;
  recordedByName: string | null;
};

export type FlagView = {
  id: string;
  flagType: string;
  label: string;
  detail: string | null;
  severity: string;
  validTo: string | null;
};

function Banner({ state }: { state: ClinicalFactState }) {
  if (!state.message) return null;
  return (
    <p
      role={state.ok ? 'status' : 'alert'}
      style={{
        margin: 0,
        padding: 'var(--space-2) var(--space-3)',
        borderRadius: 'var(--radius-md)',
        background: state.ok ? 'var(--status-success-bg)' : 'var(--status-danger-bg)',
        color: state.ok ? 'var(--status-success-text)' : 'var(--status-danger-text)',
        fontSize: 'var(--text-sm)',
      }}
    >
      {state.message}
    </p>
  );
}

const rowStyle = {
  display: 'flex',
  gap: 'var(--space-2)',
  alignItems: 'flex-start',
  flexWrap: 'wrap',
  padding: 'var(--space-2) 0',
  borderBottom: '1px solid var(--border-subtle)',
} as const;

export function ClinicalFacts({
  patientId,
  allergies,
  flags,
}: {
  patientId: string;
  allergies: AllergyView[];
  flags: FlagView[];
}) {
  const [addA, addAAction, addingA] = useActionState<ClinicalFactState, FormData>(
    addAllergyAction,
    {},
  );
  const [statusA, statusAAction] = useActionState<ClinicalFactState, FormData>(
    setAllergyStatusAction,
    {},
  );
  const [addF, addFAction, addingF] = useActionState<ClinicalFactState, FormData>(
    addFlagAction,
    {},
  );
  const [endF, endFAction] = useActionState<ClinicalFactState, FormData>(
    endFlagAction,
    {},
  );

  const [showAllergyForm, setShowAllergyForm] = useState(false);
  const [showFlagForm, setShowFlagForm] = useState(false);
  const [retracting, setRetracting] = useState<string | null>(null);

  const active = allergies.filter((a) => a.status === 'active');
  const inactive = allergies.filter((a) => a.status !== 'active');
  const liveFlags = flags.filter((f) => !f.validTo);

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <Banner state={addA} />
      <Banner state={statusA} />
      <Banner state={addF} />
      <Banner state={endF} />

      {/* ------------------------------------------------------ allergies */}
      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 'var(--space-2)',
          }}
        >
          <strong style={{ fontSize: 'var(--text-sm)' }}>Allergies</strong>
          <Button size="sm" variant="ghost" onClick={() => setShowAllergyForm((v) => !v)}>
            {showAllergyForm ? 'Cancel' : 'Record allergy'}
          </Button>
        </div>

        {showAllergyForm ? (
          <form
            action={addAAction}
            style={{
              display: 'grid',
              gap: 'var(--space-3)',
              padding: 'var(--space-3)',
              background: 'var(--bg-sunken)',
              borderRadius: 'var(--radius-md)',
              marginBottom: 'var(--space-3)',
            }}
          >
            <input type="hidden" name="patientId" value={patientId} />
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))',
                gap: 'var(--space-3)',
              }}
            >
              <Field
                id="allergenType"
                label="Type"
                required
                error={addA.errors?.['allergenType']?.[0]}
              >
                <Select name="allergenType" defaultValue="drug">
                  {ALLERGEN_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                id="allergenName"
                label="Allergen"
                required
                error={addA.errors?.['allergenName']?.[0]}
              >
                <Input name="allergenName" autoFocus />
              </Field>
              <Field
                id="severity"
                label="Severity"
                required
                hint="Drives how it is displayed"
                error={addA.errors?.['severity']?.[0]}
              >
                <Select name="severity" defaultValue="moderate">
                  {ALLERGY_SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {ALLERGY_SEVERITY_LABELS[s]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="onsetDate" label="Onset" error={addA.errors?.['onsetDate']?.[0]}>
                <Input name="onsetDate" type="date" />
              </Field>
            </div>
            <Field id="reaction" label="Reaction" error={addA.errors?.['reaction']?.[0]}>
              <Input name="reaction" placeholder="e.g. anaphylaxis, rash" />
            </Field>
            <div>
              <Button type="submit" variant="primary" size="sm" loading={addingA}>
                Record allergy
              </Button>
            </div>
          </form>
        ) : null}

        {active.length === 0 ? (
          <p
            style={{
              margin: 0,
              fontSize: 'var(--text-sm)',
              color: 'var(--text-secondary)',
            }}
          >
            No allergies recorded.{' '}
            <strong>This is not the same as none being present</strong> — confirm with the
            patient.
          </p>
        ) : (
          active.map((a) => (
            <div key={a.id} style={rowStyle}>
              <Badge
                tone={
                  a.severity === 'life_threatening' || a.severity === 'severe'
                    ? 'danger'
                    : 'warning'
                }
              >
                {a.severity ? ALLERGY_SEVERITY_LABELS[a.severity as 'mild'] : 'unknown'}
              </Badge>
              <span style={{ flex: '1 1 12rem' }}>
                <strong>{a.allergenName}</strong>
                {a.reaction ? ` — ${a.reaction}` : ''}
                <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
                  {' '}
                  ({a.allergenType})
                </span>
              </span>

              {retracting === a.id ? (
                <form
                  action={statusAAction}
                  style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}
                >
                  <input type="hidden" name="allergyId" value={a.id} />
                  <input type="hidden" name="patientId" value={patientId} />
                  <label className="sr-only" htmlFor={`reason-${a.id}`}>
                    Reason
                  </label>
                  <Input
                    id={`reason-${a.id}`}
                    name="reason"
                    placeholder="Reason (required)"
                  />
                  <Button
                    type="submit"
                    name="status"
                    value="entered_in_error"
                    size="sm"
                    variant="danger"
                  >
                    Entered in error
                  </Button>
                  <Button type="submit" name="status" value="inactive" size="sm">
                    No longer applies
                  </Button>
                </form>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setRetracting(a.id)}>
                  Correct
                </Button>
              )}
            </div>
          ))
        )}

        {/*
          Retracted allergies stay visible. A clinician who sees one vanish cannot tell
          whether it was wrong or whether they misremembered it.
        */}
        {inactive.length > 0 ? (
          <details style={{ marginTop: 'var(--space-2)' }}>
            <summary
              style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}
            >
              {inactive.length} withdrawn or inactive
            </summary>
            {inactive.map((a) => (
              <div key={a.id} style={{ ...rowStyle, opacity: 0.6 }}>
                <Badge tone="neutral">{a.status.replace(/_/g, ' ')}</Badge>
                <span>
                  <s>{a.allergenName}</s>
                  {a.reaction ? ` — ${a.reaction}` : ''}
                </span>
              </div>
            ))}
          </details>
        ) : null}
      </div>

      {/* ---------------------------------------------------------- flags */}
      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 'var(--space-2)',
          }}
        >
          <strong style={{ fontSize: 'var(--text-sm)' }}>Medical flags</strong>
          <Button size="sm" variant="ghost" onClick={() => setShowFlagForm((v) => !v)}>
            {showFlagForm ? 'Cancel' : 'Add flag'}
          </Button>
        </div>

        {showFlagForm ? (
          <form
            action={addFAction}
            style={{
              display: 'grid',
              gap: 'var(--space-3)',
              padding: 'var(--space-3)',
              background: 'var(--bg-sunken)',
              borderRadius: 'var(--radius-md)',
              marginBottom: 'var(--space-3)',
            }}
          >
            <input type="hidden" name="patientId" value={patientId} />
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))',
                gap: 'var(--space-3)',
              }}
            >
              <Field
                id="flagType"
                label="Type"
                required
                error={addF.errors?.['flagType']?.[0]}
              >
                <Select name="flagType" defaultValue="clinical_alert">
                  {FLAG_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {FLAG_TYPE_LABELS[t]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                id="label"
                label="Label"
                required
                error={addF.errors?.['label']?.[0]}
              >
                <Input name="label" />
              </Field>
              <Field
                id="flagSeverity"
                label="Severity"
                error={addF.errors?.['severity']?.[0]}
              >
                <Select name="severity" defaultValue="warning">
                  {FLAG_SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field id="detail" label="Detail" error={addF.errors?.['detail']?.[0]}>
              <Textarea name="detail" rows={2} />
            </Field>
            <div>
              <Button type="submit" variant="primary" size="sm" loading={addingF}>
                Add flag
              </Button>
            </div>
          </form>
        ) : null}

        {liveFlags.length === 0 ? (
          <p
            style={{
              margin: 0,
              fontSize: 'var(--text-sm)',
              color: 'var(--text-secondary)',
            }}
          >
            No active flags.
          </p>
        ) : (
          liveFlags.map((f) => (
            <div key={f.id} style={rowStyle}>
              <Badge tone={f.severity === 'critical' ? 'danger' : 'info'}>
                {FLAG_TYPE_LABELS[f.flagType as 'other'] ?? f.flagType}
              </Badge>
              <span style={{ flex: '1 1 12rem' }}>
                <strong>{f.label}</strong>
                {f.detail ? ` — ${f.detail}` : ''}
              </span>
              <form
                action={endFAction}
                style={{ display: 'flex', gap: 'var(--space-1)' }}
              >
                <input type="hidden" name="flagId" value={f.id} />
                <input type="hidden" name="patientId" value={patientId} />
                <label className="sr-only" htmlFor={`endreason-${f.id}`}>
                  Reason
                </label>
                <Input id={`endreason-${f.id}`} name="reason" placeholder="Reason" />
                <Button type="submit" size="sm" variant="secondary">
                  End
                </Button>
              </form>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
