'use server';

import { revalidatePath } from 'next/cache';

import {
  addendumInput,
  isNoteEmpty,
  noteContentInput,
  saveDraftInput,
  signNoteInput,
  startNoteInput,
} from '@/lib/note-schemas';
import { formFields, toFieldErrors, type FieldErrors } from '@/lib/patient-schemas';
import { AuthorizationError } from '@/server/auth/authorize';
import { addAddendum, createNote, saveDraft, signNote } from '@/server/data-access/notes';

/**
 * Visit note server actions.
 *
 * Public HTTP endpoints. A receptionist calling any of these directly — bypassing the UI
 * entirely — reaches the data layer, which finds no `note.*` grant, records an
 * `authz.denied` audit row, and throws before a single note column is queried.
 */

/**
 * One submit handler for the editor, branching on `intent`.
 *
 * The editor is a single form with two submit buttons. An earlier version used two
 * separate forms, which meant the "sign" form carried no content fields — so signing
 * always saw an empty note and refused. One form guarantees that signing commits exactly
 * what the clinician is looking at.
 */
export async function submitNoteAction(
  previous: NoteFormState,
  formData: FormData,
): Promise<NoteFormState> {
  return formData.get('intent') === 'sign'
    ? signNoteAction(previous, formData)
    : saveDraftAction(previous, formData);
}

export type NoteFormState = {
  errors?: FieldErrors;
  message?: string;
  ok?: boolean;
};

function authzMessage(error: unknown): NoteFormState | null {
  if (error instanceof AuthorizationError) {
    return {
      message:
        error.reason === 'UNAUTHENTICATED'
          ? 'Your session has ended. Sign in again.'
          : 'You do not have permission to do that. The attempt has been recorded.',
    };
  }
  return null;
}

function explain(reason: string): string {
  switch (reason) {
    case 'already_exists':
      return 'A note already exists for this visit.';
    case 'conflict':
      return 'Someone else edited this note while you were writing. Reload to see their version, then reapply your changes.';
    case 'already_signed':
      return 'This note is signed and cannot be edited. Add an addendum instead.';
    case 'not_signed':
      return 'This note is still a draft. Edit it directly rather than adding an addendum.';
    default:
      return 'That note could not be found.';
  }
}

/* -------------------------------------------------------------------------- */

export async function startNoteAction(
  _previous: NoteFormState,
  formData: FormData,
): Promise<NoteFormState> {
  const parsed = startNoteInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  try {
    const result = await createNote(
      parsed.data.patientId,
      parsed.data.appointmentId ?? null,
    );

    if (!result.ok) return { message: explain(result.reason) };

    revalidatePath(`/patients/${parsed.data.patientId}`);
    revalidatePath('/schedule');
    return { ok: true, message: 'Note started.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

export async function saveDraftAction(
  _previous: NoteFormState,
  formData: FormData,
): Promise<NoteFormState> {
  const parsed = saveDraftInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  const { noteId, patientId, version, ...content } = parsed.data;

  try {
    const result = await saveDraft(noteId, patientId, content, version);
    if (!result.ok) return { message: explain(result.reason) };

    revalidatePath(`/patients/${patientId}`);
    return { ok: true, message: 'Draft saved.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

/**
 * Sign.
 *
 * Refuses an empty note. Signing is an attestation that the content is accurate, and an
 * empty signed note is a legal record asserting that nothing happened during a visit that
 * did happen — worse than no note at all, because it looks complete.
 */
export async function signNoteAction(
  _previous: NoteFormState,
  formData: FormData,
): Promise<NoteFormState> {
  const parsed = signNoteInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  const draft = noteContentInput.safeParse({
    chiefComplaint: formData.get('chiefComplaint') ?? undefined,
    subjective: formData.get('subjective') ?? undefined,
    objective: formData.get('objective') ?? undefined,
    assessment: formData.get('assessment') ?? undefined,
    plan: formData.get('plan') ?? undefined,
  });

  if (draft.success && isNoteEmpty(draft.data)) {
    return { message: 'A note cannot be signed while it is empty.' };
  }

  try {
    // Save whatever is on screen first, so signing never freezes a stale version.
    if (draft.success) {
      const saved = await saveDraft(
        parsed.data.noteId,
        parsed.data.patientId,
        draft.data,
        parsed.data.version,
      );
      if (!saved.ok) return { message: explain(saved.reason) };
    }

    const result = await signNote(
      parsed.data.noteId,
      parsed.data.patientId,
      // saveDraft incremented the container's version.
      parsed.data.version + 1,
    );

    if (!result.ok) return { message: explain(result.reason) };

    revalidatePath(`/patients/${parsed.data.patientId}`);
    revalidatePath('/schedule');
    return { ok: true, message: 'Note signed. It is now part of the record.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

export async function addAddendumAction(
  _previous: NoteFormState,
  formData: FormData,
): Promise<NoteFormState> {
  const parsed = addendumInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  const { noteId, patientId, ...content } = parsed.data;

  if (isNoteEmpty(content)) {
    return { message: 'An addendum cannot be empty.' };
  }

  try {
    const result = await addAddendum(noteId, patientId, content);
    if (!result.ok) return { message: explain(result.reason) };

    revalidatePath(`/patients/${patientId}`);
    return { ok: true, message: 'Addendum added. The original version is unchanged.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}
