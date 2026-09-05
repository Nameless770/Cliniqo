import Link from 'next/link';

import { can } from '@/lib/permissions';
import { createPatientAction } from '@/server/actions/patients';
import { guardPage } from '@/server/auth/authorize';

import { PatientForm } from '../PatientForm';

/**
 * Register a patient.
 *
 * Guarded on `patient.create`, which receptionists and clinicians both hold. The clinical
 * fieldset renders only for callers who may write clinical data.
 */
export const metadata = { title: 'Register patient - Cliniqo' };
export const dynamic = 'force-dynamic';

export default async function NewPatientPage() {
  const session = await guardPage('patient.create');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          <Link href="/patients">Patients</Link>
        </p>
        <h1 style={{ fontSize: 'var(--text-xl)', margin: 'var(--space-1) 0 0' }}>
          Register patient
        </h1>
        <p
          style={{
            margin: 'var(--space-1) 0 0',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          A medical record number is issued automatically. Search first if you are unsure
          whether this person is already registered.
        </p>
      </div>

      <PatientForm
        action={createPatientAction}
        showClinical={can(session.permissions, 'patient.update.clinical')}
        submitLabel="Register patient"
      />
    </div>
  );
}
