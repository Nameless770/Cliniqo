import Link from 'next/link';
import { notFound } from 'next/navigation';

import { can } from '@/lib/permissions';
import { updatePatientAction } from '@/server/actions/patients';
import { guardPage } from '@/server/auth/authorize';
import { getPatient } from '@/server/data-access/patients';

import { PatientForm } from '../../PatientForm';

/**
 * Edit a patient.
 *
 * The defaults handed to the form are assembled field by field, never by spreading the
 * record. A spread would serialise every column the read returned into the client
 * payload - including any the current role should not see.
 */
export const dynamic = 'force-dynamic';

export default async function EditPatientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await guardPage('patient.update');
  const { id } = await params;

  const view = await getPatient(id);
  if (!view) notFound();

  const p = view.patient;
  const mayWriteClinical = can(session.permissions, 'patient.update.clinical');

  // Bound action: the id comes from the route on the SERVER, so it cannot be swapped by
  // editing a hidden form field.
  const action = updatePatientAction.bind(null, id);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          <Link href={`/patients/${id}`}>
            {p.legalLastName}, {p.legalFirstName}
          </Link>
        </p>
        <h1 style={{ fontSize: 'var(--text-xl)', margin: 'var(--space-1) 0 0' }}>
          Edit patient
        </h1>
        {!mayWriteClinical ? (
          <p
            style={{
              margin: 'var(--space-1) 0 0',
              fontSize: 'var(--text-sm)',
              color: 'var(--text-secondary)',
            }}
          >
            You can edit contact and scheduling details. Clinical fields are restricted to
            clinicians.
          </p>
        ) : null}
      </div>

      <PatientForm
        action={action}
        version={p.version}
        showClinical={mayWriteClinical}
        submitLabel="Save changes"
        defaults={{
          legalFirstName: p.legalFirstName,
          legalMiddleName: p.legalMiddleName ?? '',
          legalLastName: p.legalLastName,
          preferredName: p.preferredName ?? '',
          pronouns: p.pronouns ?? '',
          dateOfBirth: p.dateOfBirth,
          genderIdentity: p.genderIdentity ?? '',
          phonePrimary: p.phonePrimary ?? '',
          phoneSecondary: p.phoneSecondary ?? '',
          email: p.email ?? '',
          addressLine1: p.addressLine1 ?? '',
          addressLine2: p.addressLine2 ?? '',
          city: p.city ?? '',
          state: p.state ?? '',
          postalCode: p.postalCode ?? '',
          preferredLanguage: p.preferredLanguage ?? '',
          emergencyContactName: p.emergencyContactName ?? '',
          emergencyContactPhone: p.emergencyContactPhone ?? '',
          emergencyContactRelationship: p.emergencyContactRelationship ?? '',
          ...(view.scope === 'full'
            ? {
                sexAssignedAtBirth: view.patient.sexAssignedAtBirth ?? '',
                deceasedDate: view.patient.deceasedDate ?? '',
              }
            : {}),
        }}
      />
    </div>
  );
}
