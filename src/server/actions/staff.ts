'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { formFields, toFieldErrors, type FieldErrors } from '@/lib/patient-schemas';
import { ROLE_CODES } from '@/lib/roles';
import { AuthorizationError } from '@/server/auth/authorize';
import {
  createStaffAccount,
  reissueSetupToken,
  setStaffRoles,
  setStaffStatus,
} from '@/server/data-access/staff';

/**
 * Staff management actions. EVERY action in this file is administrator-only.
 *
 * That uniformity is the point, and it is why `claimAccountAction` was moved out to
 * `actions/account-claim.ts` (security review finding F16): an unauthenticated endpoint
 * sitting among these invited a new action to be written by copying a neighbour and
 * inheriting an assumption that did not apply to it. Nothing here is a boundary on its own
 * — each action's authorization is re-checked in the data-access layer it calls — but a
 * module with one trust level is one a reviewer can read as a unit.
 */

export type StaffFormState = {
  errors?: FieldErrors;
  message?: string;
  ok?: boolean;
  /**
   * The setup link, returned ONCE for the administrator to convey.
   *
   * Held only in this response. Never stored in plaintext, never logged, never emailed.
   * If the administrator loses it, the answer is to re-issue — which revokes this one.
   */
  setupToken?: string;
};

const createStaffInput = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(254)
    .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid email address.'),
  fullName: z.string().trim().min(1, 'A name is required.').max(150),
  roles: z.array(z.enum(ROLE_CODES)).min(1, 'Choose at least one role.'),
});

function authzMessage(error: unknown): StaffFormState | null {
  if (error instanceof AuthorizationError) {
    return {
      message:
        error.reason === 'UNAUTHENTICATED'
          ? 'Your session has ended. Sign in again.'
          : 'You do not have permission to manage staff. The attempt has been recorded.',
    };
  }
  return null;
}

function explain(reason: string): string {
  switch (reason) {
    case 'email_taken':
      return 'An account with that email already exists.';
    case 'last_admin':
      return 'That would leave the clinic with no active administrator. Promote someone else first.';
    case 'self_lockout':
      return 'You cannot remove your own administrator access or deactivate yourself.';
    default:
      return 'That account could not be found.';
  }
}

/* -------------------------------------------------------------------------- */

export async function createStaffAction(
  _previous: StaffFormState,
  formData: FormData,
): Promise<StaffFormState> {
  const parsed = createStaffInput.safeParse({
    email: formData.get('email'),
    fullName: formData.get('fullName'),
    roles: formData.getAll('roles'),
  });

  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  try {
    const result = await createStaffAccount(
      parsed.data.email,
      parsed.data.fullName,
      parsed.data.roles,
    );

    if (!result.ok) return { message: explain(result.reason) };

    revalidatePath('/staff');
    return {
      ok: true,
      message:
        'Account created. Give this setup link to them directly — it is shown once.',
      ...(result.setupToken ? { setupToken: result.setupToken } : {}),
    };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

export async function reissueSetupAction(
  _previous: StaffFormState,
  formData: FormData,
): Promise<StaffFormState> {
  const userId = z.uuid().safeParse(formData.get('userId'));
  if (!userId.success) return { message: 'Invalid account reference.' };

  try {
    const result = await reissueSetupToken(userId.data);
    if (!result.ok) return { message: explain(result.reason) };

    revalidatePath('/staff');
    return {
      ok: true,
      message: 'New setup link issued. The previous one no longer works.',
      ...(result.setupToken ? { setupToken: result.setupToken } : {}),
    };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

export async function setRolesAction(
  _previous: StaffFormState,
  formData: FormData,
): Promise<StaffFormState> {
  const parsed = z
    .object({
      userId: z.uuid(),
      roles: z.array(z.enum(ROLE_CODES)).min(1, 'Choose at least one role.'),
    })
    .safeParse({ userId: formData.get('userId'), roles: formData.getAll('roles') });

  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  try {
    const result = await setStaffRoles(parsed.data.userId, parsed.data.roles);
    if (!result.ok) return { message: explain(result.reason) };

    revalidatePath('/staff');
    return { ok: true, message: 'Roles updated. Their live sessions were ended.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

export async function setStatusAction(
  _previous: StaffFormState,
  formData: FormData,
): Promise<StaffFormState> {
  const parsed = z
    .object({
      userId: z.uuid(),
      status: z.enum(['active', 'suspended', 'deactivated']),
    })
    .safeParse(formFields(formData));

  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  try {
    const result = await setStaffStatus(parsed.data.userId, parsed.data.status);
    if (!result.ok) return { message: explain(result.reason) };

    revalidatePath('/staff');
    return {
      ok: true,
      message:
        parsed.data.status === 'active'
          ? 'Account reactivated.'
          : 'Account deactivated and all their sessions ended.',
    };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}
