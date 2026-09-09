'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { formFields } from '@/lib/patient-schemas';
import {
  portalBookInput,
  portalCancelInput,
  portalClaimInput,
  portalLoginInput,
  portalRescheduleInput,
  portalSlotsInput,
} from '@/lib/portal-schemas';
import { checkIpRateLimit, recordAttempt } from '@/server/auth/rate-limit';
import { requestMeta, safeInet } from '@/server/auth/session';
import {
  redeemPatientSetupToken,
  verifyPatientLogin,
} from '@/server/portal/accounts';
import {
  bookMyAppointment,
  cancelMyAppointment,
  getOpenSlots,
  rescheduleMyAppointment,
  type ProviderOpenings,
} from '@/server/portal/data';
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

/**
 * The booking screen's one action: find open times, and take one.
 *
 * ONE action rather than two because the screen has one piece of state — the list of
 * openings — and both operations change it. Booking has to hand back a freshly recomputed
 * list, or the slot just taken sits there looking available until the patient reloads. Two
 * separate action states would leave the component deciding which of them is newer, which
 * is a bug waiting for the first patient who changes visit type after booking.
 *
 * `intent` selects the operation and is stripped before validation, so each branch still
 * parses against a `.strict()` schema that knows nothing about it.
 */
export type PortalScheduleState = {
  /** The visit type the openings below belong to. */
  typeId?: string;
  typeName?: string;
  durationMinutes?: number;
  clinicTimeZone?: string;
  providers?: ProviderOpenings[];
  message?: string;
  ok?: boolean;
  errors?: Record<string, string[]>;
};

async function openingsFor(
  appointmentTypeId: string,
): Promise<Omit<PortalScheduleState, 'message' | 'ok' | 'errors'>> {
  const slots = await getOpenSlots(appointmentTypeId);
  if (!slots.ok) return {};
  return {
    typeId: appointmentTypeId,
    typeName: slots.typeName,
    durationMinutes: slots.durationMinutes,
    clinicTimeZone: slots.clinicTimeZone,
    providers: slots.providers,
  };
}

export async function portalScheduleAction(
  _prev: PortalScheduleState,
  formData: FormData,
): Promise<PortalScheduleState> {
  const fields = formFields(formData);
  const intent = fields['intent'];
  delete fields['intent'];

  if (intent === 'book') {
    const parsed = portalBookInput.safeParse(fields);
    if (!parsed.success) return { errors: fieldErrors(parsed.error) };

    const result = await bookMyAppointment(parsed.data);
    /* Recomputed either way. A refusal is usually "somebody just took that", and the
       honest response to that is a list without it. */
    const openings = await openingsFor(parsed.data.appointmentTypeId);

    if (!result.ok) {
      const messages: Record<typeof result.reason, string> = {
        invalid_time: 'That is not a valid date and time.',
        past: 'That time has passed. Please choose another.',
        outside_hours: 'The clinic is not open then.',
        unavailable: 'That clinician is not available then. Please choose another time.',
        unknown_provider: 'That clinician is not available for booking.',
        unknown_type: 'That visit type is no longer offered.',
        slot_taken: 'That slot was just taken. Please choose another time.',
      };
      return { ...openings, message: messages[result.reason] };
    }

    revalidatePath('/portal');
    return { ...openings, ok: true, message: 'Appointment booked. It is listed below.' };
  }

  const parsed = portalSlotsInput.safeParse(fields);
  if (!parsed.success) return { message: 'Choose a visit type.' };

  const openings = await openingsFor(parsed.data.appointmentTypeId);
  if (openings.typeId === undefined) {
    return { message: 'That visit type is no longer offered.' };
  }
  return openings;
}

/*
 * Why a patient was refused, in words they can act on.
 *
 * Shared by cancel and reschedule so the two never explain the same refusal differently.
 * `not_found` deliberately reads as "no longer available" rather than "that is not yours":
 * an id the caller does not own and an id that has been archived get the same answer, so
 * the portal cannot be used to probe which appointment ids exist.
 */
const CHANGE_DENIALS: Record<string, string> = {
  not_found: 'That appointment is no longer available.',
  not_changeable:
    'That appointment can no longer be changed online. Please call the clinic.',
  too_late:
    'That appointment has already started or passed. Please call the clinic.',
  invalid_time: 'That is not a valid date and time.',
  past: 'Choose a time in the future.',
  outside_hours: 'The clinic is not open then.',
  unavailable: 'That clinician is not available then. Please choose another time.',
  unknown_provider: 'That clinician is no longer taking bookings. Please call the clinic.',
  slot_taken: 'That slot was just taken. Please choose another time.',
};

export async function portalCancelAction(
  _prev: PortalFormState,
  formData: FormData,
): Promise<PortalFormState> {
  const parsed = portalCancelInput.safeParse(formFields(formData));
  if (!parsed.success) return { message: 'Bad request.' };

  const result = await cancelMyAppointment(parsed.data.appointmentId);
  if (!result.ok) return { message: CHANGE_DENIALS[result.reason] ?? 'That did not work.' };

  revalidatePath('/portal');
  return { ok: true, message: 'Appointment cancelled.' };
}

export async function portalRescheduleAction(
  _prev: PortalFormState,
  formData: FormData,
): Promise<PortalFormState> {
  const parsed = portalRescheduleInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const result = await rescheduleMyAppointment(
    parsed.data.appointmentId,
    parsed.data.startsAt,
  );
  if (!result.ok) return { message: CHANGE_DENIALS[result.reason] ?? 'That did not work.' };

  revalidatePath('/portal');
  return { ok: true, message: 'Appointment moved.' };
}
