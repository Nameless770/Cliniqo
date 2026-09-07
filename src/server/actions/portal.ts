'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { formFields } from '@/lib/patient-schemas';
import {
  portalBookInput,
  portalClaimInput,
  portalLoginInput,
} from '@/lib/portal-schemas';
import { checkIpRateLimit, recordAttempt } from '@/server/auth/rate-limit';
import { requestMeta, safeInet } from '@/server/auth/session';
import {
  redeemPatientSetupToken,
  verifyPatientLogin,
} from '@/server/portal/accounts';
import { bookMyAppointment } from '@/server/portal/data';
import {
  clearPortalCookie,
  getPatientSession,
  revokeAllPatientSessions,
  setPortalCookie,
} from '@/server/portal/session';

/**
 * Patient portal server actions.
 *
 * Entirely separate from the staff actions: a patient authenticates against
 * `patient_account`, never `user_account`, and holds no permissions. The one thing every
 * write here trusts is the portal session's own `patientId`, resolved server-side.
 */

export type PortalFormState = {
  errors?: Record<string, string[]>;
  message?: string;
  ok?: boolean;
};

function fieldErrors(error: import('zod').ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

export async function portalLoginAction(
  _prev: PortalFormState,
  formData: FormData,
): Promise<PortalFormState> {
  const parsed = portalLoginInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const { ip: rawIp } = await requestMeta();
  const ip = safeInet(rawIp);

  const verdict = await checkIpRateLimit(ip);
  if (!verdict.allowed) {
    return { message: `Too many attempts. Try again in ${verdict.retryAfterMinutes} minutes.` };
  }

  const { userAgent } = await requestMeta();
  const result = await verifyPatientLogin(parsed.data.email, parsed.data.password, ip, userAgent);

  // One message for wrong email and wrong password alike — never confirm an address exists.
  await recordAttempt({ email: parsed.data.email, ip, succeeded: result.ok });
  if (!result.ok) {
    return { message: 'Invalid email or password.' };
  }

  await setPortalCookie(result.token, result.expiresAt);
  redirect('/portal');
}

export async function portalLogoutAction(): Promise<void> {
  const session = await getPatientSession();
  if (session) {
    await revokeAllPatientSessions(session.patientAccountId);
  }
  await clearPortalCookie();
  redirect('/portal/login');
}

export async function portalClaimAction(
  _prev: PortalFormState,
  formData: FormData,
): Promise<PortalFormState> {
  const parsed = portalClaimInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const { ip: rawIp } = await requestMeta();
  const ip = safeInet(rawIp);

  const verdict = await checkIpRateLimit(ip);
  if (!verdict.allowed) {
    return { message: `Too many attempts. Try again in ${verdict.retryAfterMinutes} minutes.` };
  }

  const result = await redeemPatientSetupToken(parsed.data.token, parsed.data.password, ip);
  if (!result.ok) {
    return {
      message:
        'That link is not valid. It may have expired or already been used. Ask the clinic for a new one.',
    };
  }

  return { ok: true, message: 'Password set. You can now sign in.' };
}

export async function portalBookAction(
  _prev: PortalFormState,
  formData: FormData,
): Promise<PortalFormState> {
  const parsed = portalBookInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const result = await bookMyAppointment(parsed.data);
  if (!result.ok) {
    const messages: Record<typeof result.reason, string> = {
      invalid_time: 'That is not a valid date and time.',
      past: 'Choose a time in the future.',
      outside_hours: 'The clinic is not open then. Check the opening hours shown above.',
      unavailable: 'That clinician is not available then. Please choose another time.',
      unknown_provider: 'That clinician is not available for booking.',
      unknown_type: 'That visit type is no longer offered.',
      slot_taken: 'That slot was just taken. Please choose another time.',
    };
    return { message: messages[result.reason] };
  }

  revalidatePath('/portal');
  return { ok: true, message: 'Appointment booked. It is listed below.' };
}
