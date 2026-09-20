'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { staffPasswordSignupInput, staffSelfSignupInput } from '@/lib/signup-schemas';
import {
  clearPendingSignup,
  passwordSignupClinicId,
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
import { requestStaffAccessWithPassword } from '@/server/auth/staff-password-signup';
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

/**
 * Create a staff account with an email and a password.
 *
 * ONE OUTCOME for every valid submission: a redirect to the sign-in page with the same
 * message, whether an account was created or the address was already taken. Saying "that
 * email is already registered" would let anyone check which addresses belong to staff here.
 * Only a form error (a short password, a missing name) is answered on this page, and that
 * reveals nothing about any account.
 *
 * No session is created. The person signs in on the ordinary page, where the rate limit,
 * lockout and second factor all apply exactly as they do to every other account.
 */
export async function createStaffAccountAction(
  _prev: SignupFormState,
  formData: FormData,
): Promise<SignupFormState> {
  const clinicId = passwordSignupClinicId('staff');
  if (!clinicId) redirect('/login');

  const parsed = staffPasswordSignupInput.safeParse({
    email: formData.get('email') ?? '',
    fullName: formData.get('fullName') ?? '',
    password: formData.get('password') ?? '',
    confirm: formData.get('confirm') ?? '',
  });
  if (!parsed.success) {
    const errors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? 'form');
      (errors[key] ??= []).push(issue.message);
    }
    return { errors };
  }

  const { ip: rawIp, userAgent } = await requestMeta();
  const ip = safeInet(rawIp);

  const verdict = await checkIpRateLimit(ip);
  if (!verdict.allowed) {
    return {
      message: `Too many attempts. Try again in ${verdict.retryAfterMinutes} minutes.`,
    };
  }

  const { email, fullName, password } = parsed.data;
  const result = await requestStaffAccessWithPassword(
    { email, fullName, password },
    clinicId,
    ip,
    userAgent,
  );

  /* A taken address counts against the per-IP limit, which is what slows someone testing
     addresses one after another. The page does not know which it was. */
  await recordAttempt({ email, ip, succeeded: result.created });

  redirect('/login?registered=1');
}
