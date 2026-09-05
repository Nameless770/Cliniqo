import { notFound } from 'next/navigation';

import { guardPage } from '@/server/auth/authorize';
import { getClinicSettings } from '@/server/data-access/clinic-config';

import { SettingsForms } from './SettingsForms';

/**
 * Clinic settings. Administrator only.
 *
 * This page closes the gap that made the application unusable on a fresh install:
 * appointment types were read by the booking form and writable by nobody, so a new clinic
 * had an empty dropdown and could not book anything at all.
 */
export const metadata = { title: 'Clinic settings - Cliniqo' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  await guardPage('clinic.configure');

  const settings = await getClinicSettings();
  if (!settings) notFound();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-1)' }}>
          Clinic settings
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          Configuration, not patient data. Every change here is audited.
        </p>
      </div>

      <SettingsForms
        settings={{
          clinic: settings.clinic,
          types: settings.types.map((t) => ({
            id: t.id,
            code: t.code,
            displayName: t.displayName,
            defaultDurationMinutes: t.defaultDurationMinutes,
            isActive: t.isActive,
          })),
          hours: settings.hours.map((h) => ({
            dayOfWeek: h.dayOfWeek,
            opensAt: h.opensAt,
            closesAt: h.closesAt,
          })),
        }}
      />
    </div>
  );
}
