import { z } from 'zod';

/**
 * Provider availability and schedule-exception validation. Isomorphic — no PHI.
 */

export const EXCEPTION_KINDS = ['closure', 'time_off', 'blocked'] as const;

export const EXCEPTION_KIND_LABELS: Record<(typeof EXCEPTION_KINDS)[number], string> = {
  closure: 'Clinic closure',
  time_off: 'Time off',
  blocked: 'Blocked',
};

export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM.');

const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Choose a date and time.');

/** A provider's weekly working hours — replaces whatever is stored for that provider. */
export const providerAvailabilityInput = z.object({
  providerUserId: z.uuid('Choose a clinician.'),
  rows: z
    .array(
      z
        .object({
          dayOfWeek: z.coerce.number().int().min(0).max(6),
          startsAt: timeOfDay,
          endsAt: timeOfDay,
        })
        .refine((r) => r.endsAt > r.startsAt, {
          path: ['endsAt'],
          message: 'End must be after start.',
        }),
    )
    .max(21),
});

export type ProviderAvailabilityInput = z.infer<typeof providerAvailabilityInput>;

/**
 * A one-off exception to the normal schedule: a holiday closure, a provider's time off, or
 * a blocked window. `providerUserId` empty means the whole clinic is closed.
 */
export const exceptionInput = z
  .object({
    providerUserId: z
      .string()
      .transform((v) => (v === '' ? undefined : v))
      .optional()
      .pipe(z.uuid('Choose a clinician or the whole clinic.').optional()),
    kind: z.enum(EXCEPTION_KINDS),
    startsAt: localDateTime,
    endsAt: localDateTime,
    reason: z
      .string()
      .trim()
      .max(300)
      .transform((v) => (v === '' ? undefined : v))
      .optional(),
  })
  .strict()
  .refine((v) => v.endsAt > v.startsAt, {
    path: ['endsAt'],
    message: 'End must be after start.',
  });

export type ExceptionInput = z.infer<typeof exceptionInput>;
