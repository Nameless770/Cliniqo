import { z } from 'zod';

/**
 * Prescription validation.
 *
 * Isomorphic — shapes and limits only, no PHI.
 *
 * Dose, route, frequency and duration are the fields a dispensing error hides in, so they
 * are required rather than optional. A prescription missing its frequency is not a
 * partially-complete record; it is an instruction a pharmacist cannot safely fill.
 */

/** Free text, because real prescribing does not fit a dropdown. Bounded, and required. */
const required = (label: string, max: number) =>
  z
    .string({ message: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `Keep ${label.toLowerCase()} under ${max} characters.`);

export const ROUTES = [
  'oral',
  'topical',
  'inhaled',
  'intramuscular',
  'subcutaneous',
  'intravenous',
  'rectal',
  'ophthalmic',
  'otic',
  'nasal',
] as const;

export const prescriptionItemInput = z
  .object({
    medicationId: z.uuid('Choose a medication from the formulary.'),

    /** e.g. "500 mg", "2 puffs". Free text: strengths do not enumerate. */
    dose: required('Dose', 100),
    route: z.enum(ROUTES, { message: 'Choose a route of administration.' }),
    /** e.g. "three times daily", "every 6 hours as needed". */
    frequency: required('Frequency', 120),

    durationDays: z.coerce
      .number({ message: 'Duration is required.' })
      .int('Duration must be a whole number of days.')
      .min(1, 'Duration must be at least one day.')
      .max(365, 'Duration cannot exceed a year. Issue a repeat instead.'),

    quantity: z.coerce
      .number({ message: 'Quantity is required.' })
      .positive('Quantity must be greater than zero.')
      .max(10_000, 'That quantity looks wrong — please check.'),
    quantityUnit: required('Quantity unit', 40),

    refills: z.coerce
      .number()
      .int()
      .min(0, 'Refills cannot be negative.')
      .max(11, 'More than 11 refills is not permitted.')
      .default(0),

    /** The sig — patient-facing directions. */
    instructions: z
      .string()
      .trim()
      .max(1000)
      .transform((v) => (v === '' ? undefined : v))
      .optional(),

    /** Why it was prescribed. Clinical. */
    indication: z
      .string()
      .trim()
      .max(500)
      .transform((v) => (v === '' ? undefined : v))
      .optional(),
  })
  .strict();

export type PrescriptionItemInput = z.infer<typeof prescriptionItemInput>;

export const createPrescriptionInput = z.object({
  patientId: z.uuid(),
  /** Nullable: a repeat can be issued outside a documented visit. */
  visitNoteId: z.uuid().optional(),
  ...prescriptionItemInput.shape,
});

export type CreatePrescriptionInput = z.infer<typeof createPrescriptionInput>;

/**
 * A correction.
 *
 * Carries the full replacement content plus the id being replaced and why. There is no
 * "edit" input type, because there is no edit — see the data layer.
 */
export const correctPrescriptionInput = z.object({
  originalPrescriptionId: z.uuid(),
  patientId: z.uuid(),
  reason: required('A reason for the correction', 500),
  ...prescriptionItemInput.shape,
});

export const cancelPrescriptionInput = z.object({
  prescriptionId: z.uuid(),
  patientId: z.uuid(),
  reason: required('A reason', 500),
});

export const PRESCRIPTION_STATUS_LABELS = {
  draft: 'Draft',
  signed: 'Active',
  printed: 'Printed',
  cancelled: 'Cancelled',
} as const;
