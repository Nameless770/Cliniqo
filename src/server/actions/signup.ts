'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { staffSelfSignupInput } from '@/lib/signup-schemas';
import {
  clearPendingSignup,
  readPendingSignup,
  signupClinicId,
} from '@/server/auth/pending-signup';
import { checkIpRateLimit, recordAttempt } from '@/server/auth/rate-limit';
import {
  requestMeta,
  safeInet,
  sessionCookieName,
  sessionCookieOptions,
} from '@/server/auth/session';
import { createSelfRegisteredStaff } from '@/server/auth/staff-signup';

export type SignupFormState = {
  message?: string;
  errors?: Record<string, string[]>;
};

/**
 * A new staff member confirms they want an account.
 *
 * A PUBLIC endpoint like every server action, so it trusts nothing the page did. What makes
 * it safe to call without a session is the signed pending token: without one — minted by the
 * Google callback, for this audience, unexpired — nothing happens. The email and Google
 * subject come from that token and never from the form; the form supplies a name and nothing
 * else, and in particular no role.
 */
export async function requestStaffAccessAction(
  _prev: SignupFormState,
  formData: FormData,
): Promise<SignupFormState> {
  const clinicId = signupClinicId('staff');
  if (!clinicId) redirect('/login');

  const pending = await readPendingSignup('staff');
  if (!pending) redirect('/login?error=sso');

  const parsed = staffSelfSignupInput.safeParse({
    fullName: formData.get('fullName') ?? '',
  });
  if (!parsed.success) {
    return { errors: { fullName: parsed.error.issues.map((issue) => issue.message) } };
  }

  const { ip: rawIp, userAgent } = await requestMeta();
  const ip = safeInet(rawIp);

  const verdict = await checkIpRateLimit(ip);
  if (!verdict.allowed) {
    return {
      message: `Too many attempts. Try again in ${verdict.retryAfterMinutes} minutes.`,
    };
  }

  const result = await createSelfRegisteredStaff(
    pending,
    parsed.data.fullName,
    clinicId,
    ip,
    userAgent,
  );

  await recordAttempt({
    email: pending.email,
    ip,
    ...(result.ok ? { userId: result.userId, clinicId } : {}),
    succeeded: result.ok,
  });

  /* Spent whichever way it went. A token that survived a failure could be replayed. */
  await clearPendingSignup('staff');

  if (!result.ok) redirect('/login?error=sso');

  const jar = await cookies();
  jar.set(sessionCookieName(), result.token, {
    ...sessionCookieOptions(),
    expires: result.expiresAt,
  });
  redirect('/dashboard');
}
