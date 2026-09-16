import { z } from 'zod';

/**
 * Visit note validation.
 *
 * Isomorphic — shapes and limits only, no PHI.
 *
 * The SOAP fields are all optional individually. A note in progress is legitimately
 * half-empty, and refusing to save a partial draft is how clinicians end up keeping notes
 * in a text file. What matters is that a note cannot be SIGNED empty — that check is on
 * the sign path, not the save path.
 */

const noteText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep this under ${max.toLocaleString()} characters.`)
    .transform((v) => (v === '' ? undefined : v))
    .optional();

export const noteContentInput = z
  .object({
    /** Why the patient came in, in their words. */
    chiefComplaint: noteText(500),
    /** Subjective: what the patient reports. */
    subjective: noteText(20_000),
    /** Objective: what the clinician observed and measured. */
    objective: noteText(20_000),
    /** Assessment: the clinical impression. */
    assessment: noteText(20_000),
    /** Plan: what happens next. */
    plan: noteText(20_000),
  })
  .strict();

export type NoteContentInput = z.infer<typeof noteContentInput>;

/** True when every SOAP field is blank. */
export function isNoteEmpty(content: NoteContentInput): boolean {
  return (
    !content.chiefComplaint &&
    !content.subjective &&
    !content.objective &&
    !content.assessment &&
    !content.plan
  );
}

export const saveDraftInput = z.object({
  noteId: z.uuid(),
  patientId: z.uuid(),
  version: z.coerce.number().int().min(1),
  ...noteContentInput.shape,
});

export const signNoteInput = z.object({
  noteId: z.uuid(),
  patientId: z.uuid(),
  version: z.coerce.number().int().min(1),
});

export const addendumInput = z.object({
  noteId: z.uuid(),
  patientId: z.uuid(),
  ...noteContentInput.shape,
});

/**
 * Hold a signed note back from the patient's portal, or release it.
 *
 * A reason is REQUIRED to withhold, and more than a word: this is a clinician's judgement
 * that reading the note online now is reasonably likely to endanger the patient
 * (§164.524(a)(3)(i)), and a decision like that has to be reviewable later. The database
 * enforces the same rule with a CHECK constraint.
 */
export const notePortalVisibilityInput = z.discriminatedUnion('intent', [
  z.object({
    intent: z.literal('withhold'),
    noteId: z.uuid(),
    patientId: z.uuid(),
    reason: z
      .string({ message: 'Say why this note should not be shown to the patient yet.' })
      .trim()
      .min(10, 'Say why this note should not be shown to the patient yet.')
      .max(1000, 'Keep the reason to 1000 characters or fewer.'),
  }),
  z.object({
    intent: z.literal('release'),
    noteId: z.uuid(),
    patientId: z.uuid(),
  }),
]);

export const startNoteInput = z.object({
  patientId: z.uuid(),
  appointmentId: z.uuid().optional(),
});

export const NOTE_STATUS_LABELS = {
  draft: 'Draft',
  signed: 'Signed',
  amended: 'Amended',
} as const;

export const VERSION_KIND_LABELS = {
  draft: 'Draft',
  signed: 'Signed',
  addendum: 'Addendum',
} as const;
