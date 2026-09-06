import { z } from 'zod';

/**
 * Appointment input validation.
 *
 * Isomorphic — no PHI, no secrets, only shapes.
 */

export const APPOINTMENT_STATUSES = [
  'scheduled',
  'checked_in',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = {
  scheduled: 'Scheduled',
  checked_in: 'Checked in',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};

/**
 * Legal status transitions.
 *
 * Encoded as data rather than scattered `if` statements, so the rules are reviewable in
 * one place and the same table drives both the server guard and which buttons render.
 *
 * `cancelled` and `no_show` are terminal: reversing them would resurrect an appointment
 * into a slot the exclusion constraint may since have given to somebody else. Correcting
 * a mistaken cancellation means booking again, which is also what leaves an honest trail.
 */
export const ALLOWED_TRANSITIONS: Record<
  AppointmentStatus,
  readonly AppointmentStatus[]
> = {
  scheduled: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['in_progress', 'completed', 'cancelled', 'no_show'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
};

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/* -------------------------------------------------------------------------- */

/*
 * A WALL-CLOCK date and time in the clinic's zone — 'YYYY-MM-DDTHH:mm', exactly what a
 * browser's datetime-local input submits. Deliberately NOT an instant.
 *
 * The shape is pinned with a regex rather than accepted on `new Date(v)` not being NaN.
 * That older check passed things the converter cannot use (a bare '2027-03-01'), and
 * worse, it evaluated the string in the SERVER's timezone — the very confusion this type
 * now exists to prevent. Validation and conversion must agree on the shape, or one of
 * them is deciding something the other did not intend.
 */
const isoDateTime = z
  .string()
  .min(1, 'Choose a date and time.')
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/,
    'Choose a date and time.',
  )
  .refine(
    (v) => !Number.isNaN(new Date(`${v}Z`).getTime()),
    'That is not a valid date and time.',
  );

export const bookAppointmentInput = z
  .object({
    patientId: z.uuid('Choose a patient.'),
    providerUserId: z.uuid('Choose a clinician.'),
    appointmentTypeId: z.uuid('Choose an appointment type.'),

    /** Local datetime from the form; converted to an instant on the server. */
    startsAt: isoDateTime,
    durationMinutes: z.coerce
      .number()
      .int()
      .min(5, 'An appointment must be at least 5 minutes.')
      .max(480, 'An appointment cannot exceed 8 hours.'),

    /**
     * Logistics only, and labelled as such in the UI.
     *
     * The reason for the visit is the coded appointment TYPE, not free text — a
     * free-text reason field at a front desk fills up with clinical detail that
     * receptionists are not permitted to hold.
     */
    bookingNote: z
      .string()
      .trim()
      .max(500)
      .transform((v) => (v === '' ? undefined : v))
      .optional(),
  })
  .strict()
  .refine((v) => new Date(v.startsAt).getTime() > Date.now() - 60 * 60 * 1000, {
    path: ['startsAt'],
    message: 'That time is in the past. Choose a future slot.',
  });

export type BookAppointmentInput = z.infer<typeof bookAppointmentInput>;

export const rescheduleAppointmentInput = z
  .object({
    appointmentId: z.uuid(),
    startsAt: isoDateTime,
    durationMinutes: z.coerce.number().int().min(5).max(480),
  })
  .strict();

export const cancelAppointmentInput = z
  .object({
    appointmentId: z.uuid(),
    /** Required: a cancellation without a reason is an unanswerable question later. */
    reason: z
      .string()
      .trim()
      .min(1, 'Give a reason for the cancellation.')
      .max(500, 'Keep the reason under 500 characters.'),
  })
  .strict();

export const changeStatusInput = z
  .object({
    appointmentId: z.uuid(),
    status: z.enum(APPOINTMENT_STATUSES),
  })
  .strict();

export const scheduleViewInput = z.object({
  /** YYYY-MM-DD anchor. Defaults to today, resolved server-side in clinic time. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  view: z.enum(['day', 'week']).optional().default('day'),
  /** Filter to one clinician. A doctor's view defaults to themselves. */
  providerUserId: z.uuid().optional(),
});

export type ScheduleViewInput = z.infer<typeof scheduleViewInput>;
