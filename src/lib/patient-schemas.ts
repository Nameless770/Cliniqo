import { z } from 'zod';

/**
 * Patient input validation.
 *
 * Isomorphic: the same schemas validate on the server and drive client-side messages, so
 * the two can never disagree about what is acceptable. Contains no PHI and no secrets —
 * only shapes and rules.
 *
 * THE SPLIT IS THE ACCESS CONTROL. `identifyingPatientInput` and `clinicalPatientInput`
 * are separate schemas, not one schema with optional fields, because the server picks
 * which to parse based on the caller's permissions. A receptionist's payload is parsed by
 * a schema in which clinical fields do not exist — so they cannot be written, whatever
 * the request body contained.
 */

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/** Trim, and turn empty strings into undefined so blank form fields clear a value. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? undefined : v))
    .optional();

const requiredText = (label: string, max: number) =>
  z
    .string({ message: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} must be ${max} characters or fewer.`);

/**
 * Permissive on purpose.
 *
 * Real phone numbers carry extensions, country codes, and punctuation, and real patients
 * are turned away by validators that assume a national format. The clinic can call a
 * number that fails a regex; it cannot call one that was never recorded.
 */
const phone = optionalText(40);

const email = z
  .string()
  .trim()
  .max(254)
  .transform((v) => (v === '' ? undefined : v))
  .optional()
  .refine((v) => v === undefined || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
    message: 'Enter a valid email address, or leave it blank.',
  });

/**
 * Date of birth.
 *
 * Rejects the future and implausible ages. A typo of 2026 for 1926 is common and produces
 * a record that breaks every age-based clinical rule downstream, so it is caught here
 * rather than discovered later.
 */
const dateOfBirth = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date of birth as YYYY-MM-DD.')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime());
  }, 'That is not a real date.')
  .refine(
    (value) => new Date(`${value}T00:00:00Z`) <= new Date(),
    'Date of birth cannot be in the future.',
  )
  .refine((value) => {
    const years =
      (Date.now() - new Date(`${value}T00:00:00Z`).getTime()) / 31_557_600_000;
    return years < 130;
  }, 'Date of birth looks implausible — please check the year.');

/* -------------------------------------------------------------------------- */
/* Identifying fields — what a receptionist may write                         */
/* -------------------------------------------------------------------------- */

/**
 * `.strict()` matters.
 *
 * Zod strips unknown keys by default, which would silently discard a clinical field a
 * receptionist tried to submit. Silent is wrong: the write should FAIL and be recorded,
 * because a request carrying fields the caller cannot write is either a bug or a probe,
 * and both are worth seeing.
 */
export const identifyingPatientInput = z
  .object({
    legalFirstName: requiredText('First name', 100),
    legalMiddleName: optionalText(100),
    legalLastName: requiredText('Last name', 100),

    /** What staff actually call the patient. Distinct from the legal name insurance needs. */
    preferredName: optionalText(100),
    pronouns: optionalText(50),

    dateOfBirth,

    /**
     * Gender identity is free text and identifying; sex assigned at birth is a
     * constrained clinical field and lives in the clinical schema below. They are
     * different questions and are deliberately not collapsed into one.
     */
    genderIdentity: optionalText(80),

    phonePrimary: phone,
    phoneSecondary: phone,
    email,

    addressLine1: optionalText(200),
    addressLine2: optionalText(200),
    city: optionalText(100),
    state: optionalText(100),
    postalCode: optionalText(20),

    preferredLanguage: optionalText(80),

    emergencyContactName: optionalText(150),
    emergencyContactPhone: phone,
    emergencyContactRelationship: optionalText(80),
  })
  .strict();

export type IdentifyingPatientInput = z.infer<typeof identifyingPatientInput>;

/* -------------------------------------------------------------------------- */
/* Clinical fields — clinician only                                           */
/* -------------------------------------------------------------------------- */

export const clinicalPatientFields = z
  .object({
    /** Clinically load-bearing: reference ranges and screening eligibility. */
    sexAssignedAtBirth: z.enum(['male', 'female', 'intersex', 'unknown']).optional(),
    deceasedDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as YYYY-MM-DD.')
      .optional(),
  })
  .strict();

/** The full schema a clinician's payload is parsed by. */
export const clinicalPatientInput = identifyingPatientInput
  .extend(clinicalPatientFields.shape)
  .strict();

export type ClinicalPatientInput = z.infer<typeof clinicalPatientInput>;

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Registration.
 *
 * `confirmedNotDuplicate` exists because duplicate charts are a patient-safety problem,
 * not a tidiness problem: an allergy recorded on chart A is invisible on chart B. The
 * server refuses a registration that collides with an existing live patient on surname
 * and date of birth unless the user has explicitly confirmed they are different people.
 */
export const createPatientInput = identifyingPatientInput.extend({
  confirmedNotDuplicate: z.boolean().optional().default(false),
});

export type CreatePatientInput = z.infer<typeof createPatientInput>;

/* -------------------------------------------------------------------------- */
/* Search and archive                                                         */
/* -------------------------------------------------------------------------- */

export const patientSearchInput = z.object({
  /** Empty means "list everyone", which is a legitimate roster view. */
  query: z.string().trim().max(120).optional().default(''),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  pageSize: z.coerce.number().int().min(5).max(100).optional().default(25),
  includeArchived: z.boolean().optional().default(false),
});

export type PatientSearchInput = z.infer<typeof patientSearchInput>;

/** F6: the unarchive path previously took a raw string straight from the form. */
export const unarchivePatientInput = z.object({
  patientId: z.uuid('Not a valid patient reference.'),
});

export const archivePatientInput = z.object({
  patientId: z.uuid('Not a valid patient reference.'),
  /**
   * Required. Archival is a clinical-record action and "why" is part of the record —
   * a reason box nobody must fill in is a reason box nobody fills in.
   */
  reason: requiredText('A reason', 500),
});

/* -------------------------------------------------------------------------- */
/* Error shaping                                                              */
/* -------------------------------------------------------------------------- */

export type FieldErrors = Record<string, string[]>;

/**
 * Flatten zod issues to per-field messages for the form.
 *
 * Returns only field paths and messages. Zod's issues can echo the received value, and
 * for this schema the received value is patient data — it must not travel back in an
 * error payload, into a log, or into a screenshot.
 */
export function toFieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_form';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/**
 * The user-submitted fields of a form, with the framework's own keys removed.
 *
 * React's progressive-enhancement encoding for server actions travels in the same
 * FormData as the user's input: `$ACTION_REF_2`, `$ACTION_2:0`, `$ACTION_KEY` and
 * friends. They are transport, not input — the user never typed them and no schema
 * should have an opinion about them.
 *
 * WHY THIS EXISTS. Every action here validates with a `.strict()` schema, which is the
 * right default: it rejects fields nobody declared instead of silently ignoring them,
 * which is what stops a receptionist's form from smuggling a clinical column. But strict
 * mode also rejects the framework's keys, producing an `unrecognized_keys` issue with an
 * EMPTY path — so it lands under `_form`, which no form renders. The observed behaviour
 * was a "Book appointment" button that did nothing at all: no row, no error, no message.
 *
 * Stripping by prefix rather than loosening the schemas keeps the strictness that makes
 * the field boundary enforceable, and confines the knowledge of React's encoding to one
 * function. `scripts/security-invariants.mjs` asserts no action parses raw FormData.
 */
export function formFields(formData: FormData): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    // Covers $ACTION_REF_n, $ACTION_n:m, and $ACTION_KEY in one rule.
    if (key.startsWith('$ACTION')) continue;
    fields[key] = value;
  }
  return fields;
}
