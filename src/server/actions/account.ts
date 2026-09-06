'use server';

import { z } from 'zod';

import { formFields } from '@/lib/patient-schemas';

import { changeOwnPassword } from '@/server/data-access/staff';

/**
 * Self-service account actions.
 *
 * Separate from `staff.ts`, which is administrator-only. Everything here acts on the
 * CALLER'S OWN account and never takes a user id — there is no parameter an attacker
 * could point at somebody else, because the subject is always the session.
 */

export type AccountFormState = {
  errors?: Record<string, string[]>;
  message?: string;
  ok?: boolean;
};

/**
 * Same policy as the setup-link claim form: length over composition.
 *
 * A 12-character passphrase beats "P@ssw0rd!" on every measure that matters, and
 * composition rules mostly produce predictable substitutions of the same weak words.
 */
const changePasswordInput = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password.').max(1024),
    password: z
      .string()
      .min(12, 'Use at least 12 characters. A short phrase works well.')
      .max(1024),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    path: ['confirm'],
    message: 'Those do not match.',
  })
  .refine((v) => v.password !== v.currentPassword, {
    path: ['password'],
    message: 'That is your current password. Choose a different one.',
  });

function toFieldErrors(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

export async function changePasswordAction(
  _previous: AccountFormState,
  formData: FormData,
): Promise<AccountFormState> {
  const parsed = changePasswordInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  const result = await changeOwnPassword(
    parsed.data.currentPassword,
    parsed.data.password,
  );

  if (!result.ok) {
    switch (result.reason) {
      case 'wrong_password':
        return { errors: { currentPassword: ['That is not your current password.'] } };
      case 'reused_password':
        return { errors: { password: ['Choose a password you have not just used.'] } };
      case 'no_password_set':
        return {
          message:
            'This account has no password yet. Use the setup link an administrator issued you.',
        };
    }
  }

  /*
   * No redirect() here. The data layer has just revoked every session including this one,
   * so the caller is signed out; the form renders a success message with a link to sign
   * in again. Redirecting would race the cookie invalidation and could bounce the user
   * through a page that then rejects them, which reads like the change failed.
   */
  return { ok: true, message: 'Password changed. Sign in again with your new password.' };
}
