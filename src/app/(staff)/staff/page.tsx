import { guardPage } from '@/server/auth/authorize';
import { listStaff } from '@/server/data-access/staff';

import { StaffAdmin } from './StaffAdmin';

/**
 * Staff management. Administrator only, enforced by guardPage AND by each action's own
 * permission check in the data layer.
 */
export const metadata = { title: 'Staff - Cliniqo' };
export const dynamic = 'force-dynamic';

export default async function StaffPage() {
  await guardPage('staff.read');
  const staff = await listStaff();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-1)' }}>
          Staff
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          One account per person. Accounts are never deleted - deactivating ends their
          sessions immediately and preserves everything they signed.
        </p>
      </div>

      <StaffAdmin
        staff={staff.map((s) => ({
          id: s.id,
          email: s.email,
          fullName: s.fullName,
          status: s.status,
          roles: s.roles,
          lastLoginAt: s.lastLoginAt ? s.lastLoginAt.toISOString() : null,
          passwordSet: s.passwordSet,
          hasLiveInvitation: s.hasLiveInvitation,
        }))}
      />
    </div>
  );
}
