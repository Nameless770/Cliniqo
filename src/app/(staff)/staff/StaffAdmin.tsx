'use client';

import { useActionState, useState } from 'react';

import { Badge, Button, Field, Input } from '@/components/ui';
import { ROLE_CODES, ROLE_LABELS, type RoleCode } from '@/lib/roles';
import {
  createStaffAction,
  reissueSetupAction,
  setRolesAction,
  setStatusAction,
  type StaffFormState,
} from '@/server/actions/staff';

/**
 * Staff administration.
 *
 * Receives no credential material. `passwordSet` is a boolean computed server-side — the
 * hash never leaves the data layer, and there is no field anywhere in this component that
 * could hold a password.
 */

export type StaffView = {
  id: string;
  email: string;
  fullName: string;
  status: 'active' | 'suspended' | 'deactivated';
  roles: string[];
  lastLoginAt: string | null;
  passwordSet: boolean;
  hasLiveInvitation: boolean;
};

function Banner({ state }: { state: StaffFormState }) {
  if (!state.message) return null;
  return (
    <div
      role={state.ok ? 'status' : 'alert'}
      style={{
        padding: 'var(--space-3) var(--space-4)',
        borderRadius: 'var(--radius-md)',
        background: state.ok ? 'var(--status-success-bg)' : 'var(--status-danger-bg)',
        color: state.ok ? 'var(--status-success-text)' : 'var(--status-danger-text)',
        fontSize: 'var(--text-sm)',
      }}
    >
      {state.message}
      {state.setupToken ? <SetupLink token={state.setupToken} /> : null}
    </div>
  );
}

/**
 * The setup link, shown once.
 *
 * Rendered as selectable text rather than a mailto: or a share button — the whole point
 * is that it travels by hand, not through a channel the clinic has no BAA for.
 */
function SetupLink({ token }: { token: string }) {
  const url =
    typeof window !== 'undefined'
      ? `${window.location.origin}/claim/${token}`
      : `/claim/${token}`;

  return (
    <div style={{ marginTop: 'var(--space-3)' }}>
      <code
        style={{
          display: 'block',
          padding: 'var(--space-2) var(--space-3)',
          background: 'var(--bg-sunken)',
          color: 'var(--text-primary)',
          borderRadius: 'var(--radius-sm)',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          wordBreak: 'break-all',
          userSelect: 'all',
        }}
      >
        {url}
      </code>
      <p style={{ margin: 'var(--space-2) 0 0', fontSize: 'var(--text-xs)' }}>
        Valid for 48 hours, single use. Hand it over in person or read it out — do not
        email it. It is not shown again; re-issue if it is lost.
      </p>
    </div>
  );
}

function RolePicker({ name, selected }: { name: string; selected: string[] }) {
  return (
    <fieldset
      style={{ border: 0, padding: 0, margin: 0, display: 'flex', gap: 'var(--space-3)' }}
    >
      <legend className="sr-only">Roles</legend>
      {ROLE_CODES.map((code) => (
        <label
          key={code}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            fontSize: 'var(--text-sm)',
          }}
        >
          <input
            type="checkbox"
            name={name}
            value={code}
            defaultChecked={selected.includes(code)}
          />
          {ROLE_LABELS[code as RoleCode]}
        </label>
      ))}
    </fieldset>
  );
}

export function StaffAdmin({ staff }: { staff: StaffView[] }) {
  const [createState, createFormAction, creating] = useActionState<
    StaffFormState,
    FormData
  >(createStaffAction, {});
  const [rowState, rowFormAction, rowPending] = useActionState<StaffFormState, FormData>(
    setRolesAction,
    {},
  );
  const [statusState, statusFormAction] = useActionState<StaffFormState, FormData>(
    setStatusAction,
    {},
  );
  const [inviteState, inviteFormAction] = useActionState<StaffFormState, FormData>(
    reissueSetupAction,
    {},
  );

  const [showCreate, setShowCreate] = useState(false);

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <Banner state={createState} />
      <Banner state={rowState} />
      <Banner state={statusState} />
      <Banner state={inviteState} />

      <div>
        <Button variant="primary" onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? 'Cancel' : 'Add staff account'}
        </Button>
      </div>

      {showCreate ? (
        <form
          action={createFormAction}
          style={{
            display: 'grid',
            gap: 'var(--space-4)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--bg-surface)',
            padding: 'var(--space-5)',
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: 'var(--text-sm)',
              color: 'var(--text-secondary)',
            }}
          >
            You do not set a password. The account is created without one, and they set
            their own using a single-use link you hand them.
          </p>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))',
              gap: 'var(--space-4)',
            }}
          >
            <Field
              id="fullName"
              label="Full name"
              required
              error={createState.errors?.['fullName']?.[0]}
            >
              <Input name="fullName" autoComplete="off" />
            </Field>
            <Field
              id="email"
              label="Email"
              required
              error={createState.errors?.['email']?.[0]}
            >
              <Input name="email" type="email" autoComplete="off" />
            </Field>
          </div>

          <div>
            <p
              style={{
                margin: '0 0 var(--space-2)',
                fontSize: 'var(--text-sm)',
                fontWeight: 'var(--weight-medium)',
              }}
            >
              Roles
            </p>
            <RolePicker name="roles" selected={[]} />
            {createState.errors?.['roles']?.[0] ? (
              <p
                role="alert"
                style={{ color: 'var(--status-danger-text)', fontSize: 'var(--text-xs)' }}
              >
                {createState.errors['roles'][0]}
              </p>
            ) : null}
          </div>

          <div>
            <Button type="submit" variant="primary" loading={creating}>
              Create account
            </Button>
          </div>
        </form>
      ) : null}

      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'grid',
          gap: 'var(--space-2)',
        }}
      >
        {staff.map((s) => (
          <li
            key={s.id}
            style={{
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              background: 'var(--bg-surface)',
              padding: 'var(--space-3) var(--space-4)',
              display: 'grid',
              gap: 'var(--space-2)',
              opacity: s.status === 'active' ? 1 : 0.65,
            }}
          >
            <div
              style={{
                display: 'flex',
                gap: 'var(--space-2)',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <strong>{s.fullName}</strong>
              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                {s.email}
              </span>
              <Badge tone={s.status === 'active' ? 'success' : 'neutral'}>
                {s.status}
              </Badge>
              {!s.passwordSet ? (
                <Badge tone={s.hasLiveInvitation ? 'info' : 'warning'}>
                  {s.hasLiveInvitation
                    ? 'Invitation pending'
                    : 'No password, no invitation'}
                </Badge>
              ) : null}
              <span
                style={{
                  marginInlineStart: 'auto',
                  fontSize: 'var(--text-xs)',
                  color: 'var(--text-muted)',
                }}
              >
                {s.lastLoginAt
                  ? `Last in ${s.lastLoginAt.slice(0, 10)}`
                  : 'Never signed in'}
              </span>
            </div>

            <div
              style={{
                display: 'flex',
                gap: 'var(--space-3)',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <form
                action={rowFormAction}
                style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}
              >
                <input type="hidden" name="userId" value={s.id} />
                <RolePicker name="roles" selected={s.roles} />
                <Button type="submit" size="sm" loading={rowPending}>
                  Save roles
                </Button>
              </form>

              <form action={statusFormAction}>
                <input type="hidden" name="userId" value={s.id} />
                <input
                  type="hidden"
                  name="status"
                  value={s.status === 'active' ? 'deactivated' : 'active'}
                />
                <Button
                  type="submit"
                  size="sm"
                  variant={s.status === 'active' ? 'danger' : 'secondary'}
                >
                  {s.status === 'active' ? 'Deactivate' : 'Reactivate'}
                </Button>
              </form>

              {!s.passwordSet ? (
                <form action={inviteFormAction}>
                  <input type="hidden" name="userId" value={s.id} />
                  <Button type="submit" size="sm" variant="ghost">
                    {s.hasLiveInvitation ? 'Re-issue link' : 'Issue setup link'}
                  </Button>
                </form>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
