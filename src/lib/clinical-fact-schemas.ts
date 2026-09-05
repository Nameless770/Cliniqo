import { z } from 'zod';

/**
 * Allergy and medical-flag validation.
 *
 * Isomorphic — shapes only, no PHI.
 */

export const ALLERGEN_TYPES = ['drug', 'food', 'environmental', 'other'] as const;

/**
 * Severity is REQUIRED, and it is an enum.
 *
 * "Allergic to penicillin" and "anaphylactic to penicillin" lead to different decisions
 * under time pressure, and free text ("bad", "severe-ish") cannot be sorted, coloured, or
 * reasoned about. An allergy without a severity is a warning a clinician has to interpret
 * at exactly the moment they have no time to.
 */
export const ALLERGY_SEVERITIES = [
  'mild',
  'moderate',
  'severe',
  'life_threatening',
] as const;

export const ALLERGY_SEVERITY_LABELS: Record<
  (typeof ALLERGY_SEVERITIES)[number],
  string
> = {
  mild: 'Mild',
  moderate: 'Moderate',
  severe: 'Severe',
  life_threatening: 'Life-threatening',
};

export const FLAG_TYPES = [
  'clinical_alert',
  'infection_control',
  'fall_risk',
  'safeguarding',
  'other',
] as const;

export const FLAG_TYPE_LABELS: Record<(typeof FLAG_TYPES)[number], string> = {
  clinical_alert: 'Clinical alert',
  infection_control: 'Infection control',
  fall_risk: 'Fall risk',
  safeguarding: 'Safeguarding',
  other: 'Other',
};

export const FLAG_SEVERITIES = ['info', 'warning', 'critical'] as const;

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? undefined : v))
    .optional();

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
  .optional()
  .or(z.literal('').transform(() => undefined));

export const allergyInput = z
  .object({
    allergenType: z.enum(ALLERGEN_TYPES, { message: 'Choose a type.' }),
    allergenName: z
      .string()
      .trim()
      .min(1, 'Name the allergen.')
      .max(200, 'Keep the allergen under 200 characters.'),
    /** What happens. Free text, because reactions do not enumerate. */
    reaction: optional(500),
    severity: z.enum(ALLERGY_SEVERITIES, {
      message: 'Choose a severity — a clinician needs it to act.',
    }),
    onsetDate: isoDate,
  })
  .strict();

export type AllergyInput = z.infer<typeof allergyInput>;

export const flagInput = z
  .object({
    flagType: z.enum(FLAG_TYPES, { message: 'Choose a flag type.' }),
    label: z.string().trim().min(1, 'Give the flag a short label.').max(200),
    detail: optional(1000),
    severity: z.enum(FLAG_SEVERITIES).default('warning'),
    validFrom: isoDate,
    validTo: isoDate,
  })
  .strict();

export type FlagInput = z.infer<typeof flagInput>;

export const addAllergyInput = allergyInput.extend({ patientId: z.uuid() });
export const addFlagInput = flagInput.extend({ patientId: z.uuid() });

/**
 * Retracting requires a reason.
 *
 * Removing an allergy from a chart is a clinically consequential act — the next
 * prescriber will not see it. Whoever does it should have to say why, and that reason
 * lands in the audit log's `purpose`.
 */
export const allergyStatusInput = z.object({
  allergyId: z.uuid(),
  patientId: z.uuid(),
  status: z.enum(['active', 'inactive', 'entered_in_error']),
  reason: z
    .string()
    .trim()
    .min(5, 'Say why — the next prescriber will not see this allergy.')
    .max(500),
});

export const endFlagInput = z.object({
  flagId: z.uuid(),
  patientId: z.uuid(),
  reason: z.string().trim().min(5, 'Say why.').max(500),
});
