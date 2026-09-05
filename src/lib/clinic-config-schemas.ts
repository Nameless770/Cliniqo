import { z } from 'zod';

/**
 * Clinic configuration validation. No PHI - clinic reference data only.
 */

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? undefined : v))
    .optional();

export const clinicInput = z
  .object({
    name: z.string().trim().min(1, 'The clinic needs a name.').max(200),
    /**
     * Validated against the runtime's own tz database rather than a hardcoded list.
     * An invalid zone here would make every schedule boundary throw at render time.
     */
    timezone: z
      .string()
      .trim()
      .min(1, 'Choose a timezone.')
      .refine((v) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, 'That is not a recognised IANA timezone, e.g. America/New_York.'),
    phone: optional(40),
    addressLine1: optional(200),
    city: optional(100),
    state: optional(100),
    postalCode: optional(20),
  })
  .strict();

export type ClinicInput = z.infer<typeof clinicInput>;

export const appointmentTypeInput = z
  .object({
    /** Short stable key. Uppercase so it reads as a code, not a label. */
    code: z
      .string()
      .trim()
      .min(1, 'Give it a short code.')
      .max(20)
      .regex(/^[A-Z0-9_-]+$/, 'Use capitals, digits, hyphen or underscore.'),
    displayName: z
      .string()
      .trim()
      .min(1, 'Give it a name staff will recognise.')
      .max(100),
    defaultDurationMinutes: z.coerce
      .number()
      .int()
      .min(5, 'At least 5 minutes.')
      .max(480, 'At most 8 hours.'),
    sortOrder: z.coerce.number().int().min(0).max(999).default(0),
  })
  .strict();

export type AppointmentTypeInput = z.infer<typeof appointmentTypeInput>;

export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** HH:MM, matching the `time` column. */
const timeOfDay = z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM.');

export const clinicHoursInput = z.object({
  rows: z
    .array(
      z
        .object({
          dayOfWeek: z.coerce.number().int().min(0).max(6),
          opensAt: timeOfDay,
          closesAt: timeOfDay,
        })
        .refine((r) => r.closesAt > r.opensAt, {
          path: ['closesAt'],
          message: 'Closing time must be after opening time.',
        }),
    )
    .max(21, 'At most three periods per day.'),
});
