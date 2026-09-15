'use server';

import { z } from 'zod';

import { formFields, toFieldErrors, type FieldErrors } from '@/lib/patient-schemas';
import { checkIpRateLimit, recordAttempt } from '@/server/auth/rate-limit';
import { requestMeta, safeInet } from '@/server/auth/session';
import { redeemSetupToken } from '@/server/data-access/staff';

/**
 * Claiming a staff account with a setup token. UNAUTHENTICATED, on purpose.
 *
 * ==========================================================================
 * WHY THIS IS ITS OWN FILE — security review finding F16
 * ==========================================================================
 *
 * This lived in `actions/staff.ts` beside `createStaffAction`, `setRolesAction` and
 * `setStatusAction`, every one of which is administrator-only. Each action checked its own
 * authorization, so it was never a vulnerability — but a file whose other exports all begin
 * with an admin check is a file where the next action gets written by copying a neighbour,
 * and the neighbour's assumption does not hold here. The trust level is a property of the
 * module now, not a paragraph in a comment somebody has to read.
 *
 * What guards this endpoint instead of a session:
 *
 *   - the setup token itself, 256 bits, single-use, hashed at rest, and issued only by an
 *     administrator;
 *   - a per-IP rate limit, the same one the login form uses;
 *   - one indistinguishable failure message for wrong, used, revoked and expired, so the
 *     endpoint cannot be used to learn whether a token ever existed.
 */

export type ClaimFormState = {
  errors?: FieldErrors;
  message?: string;
  ok?: boolean;
};

/**
 * Password policy, applied only where a password is SET — never at login.
 *
 * Length over composition: a 12-character passphrase beats "P@ssw0rd!" on every measure
 * that matters, and composition rules mostly produce predictable substitutions.
 */
const claimInput = z
  .object({
    token: z.string().min(20).max(200),
    password: z
      .string()
      .min(12, 'Use at least 12 characters. A short phrase works well.')
      .max(1024),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    path: ['confirm'],
    message: 'Those do not match.',
  });

/**
 * Claim a new account with a setup token.
 *
 * Rate limited per IP like the login form, because this endpoint accepts a bearer token
 * and would otherwise be brute-forceable. The token is 256 bits, so guessing is not a
 * realistic attack — but the limiter costs nothing and closes the enumeration angle.
 */
export async function claimAccountAction(
  _previous: ClaimFormState,
  formData: FormData,
): Promise<ClaimFormState> {
  const parsed = claimInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  const { ip: rawIp } = await requestMeta();
  const ip = safeInet(rawIp);

  const verdict = await checkIpRateLimit(ip);
  if (!verdict.allowed) {
    return {
      message: `Too many attempts. Try again in ${verdict.retryAfterMinutes} minutes.`,
    };
  }

  const result = await redeemSetupToken(parsed.data.token, parsed.data.password, ip);

  if (!result.ok) {
    await recordAttempt({ email: 'setup-token', ip, succeeded: false });
    // One message for wrong, used, revoked, and expired — see the data layer.
    return {
      message:
        'That setup link is not valid. It may have expired or already been used. Ask an administrator for a new one.',
    };
  }

  await recordAttempt({ email: result.email, ip, succeeded: true });
  return { ok: true, message: 'Password set. You can now sign in.' };
}
