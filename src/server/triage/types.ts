import 'server-only';

/**
 * The triage port.
 *
 * A deliberate seam, and the reason it exists is regulatory rather than architectural.
 * The symptom text a patient types is PHI — arguably the most sensitive kind, since it is
 * unmediated and self-reported — so sending it to a third-party model is a disclosure that
 * needs a Business Associate Agreement behind it. That is a decision for whoever runs the
 * clinic, made once, with paperwork; it is not a decision a data-access module should make
 * implicitly by importing a vendor SDK.
 *
 * So the engine is a value, chosen at startup from validated configuration. The default
 * makes no network call at all, which means the feature works — completely, not in a
 * degraded mode — for a clinic that has signed nothing.
 */

export type TriageUrgency = 'emergency' | 'urgent' | 'routine' | 'self_care';

/** The ordered set the UI and the booking queue both read. */
export const URGENCY_RANK: Record<TriageUrgency, number> = {
  emergency: 0,
  urgent: 1,
  routine: 2,
  self_care: 3,
};

export const URGENCY_LABELS: Record<TriageUrgency, string> = {
  emergency: 'Emergency',
  urgent: 'Needs to be seen soon',
  routine: 'Routine appointment',
  self_care: 'Can likely be managed at home',
};

/**
 * The specialties a recommendation may name.
 *
 * A closed list, not free text from a model. Two reasons, and the second is the real one:
 * the front desk books against clinic services and cannot act on "see a hepatologist"
 * from a practice that has no hepatologist; and a model asked for free text will
 * eventually produce a drug name, a diagnosis, or a sentence — none of which belong in a
 * column the receptionist reads as an instruction.
 */
export const SPECIALTIES = [
  'General practice',
  'Cardiology',
  'Dermatology',
  'Orthopaedics',
  'Paediatrics',
  'Obstetrics & gynaecology',
  'Ophthalmology',
  'Ear, nose & throat',
  'Gastroenterology',
  'Neurology',
  'Urology',
  'Mental health',
  'Dentistry',
] as const;

export type Specialty = (typeof SPECIALTIES)[number];

export function isSpecialty(value: string): value is Specialty {
  return (SPECIALTIES as readonly string[]).includes(value);
}

export type TriageTurn = { role: 'patient' | 'assistant'; body: string };

export type TriageRequest = {
  /** What the patient just wrote. Already trimmed and length-capped by the action. */
  message: string;
  /** Earlier turns, oldest first, so a follow-up question has its context. */
  history: TriageTurn[];
};

export type TriageResult = {
  /** Shown to the patient verbatim. Short — a few sentences at most. */
  reply: string;
  urgency: TriageUrgency;
  specialty: Specialty;
  /** 'local', or 'openai:<model>'. Recorded on the conversation row. */
  engine: string;
};

export interface TriageEngine {
  /** Recorded on the conversation, so a stored recommendation stays interpretable. */
  readonly name: string;
  assess(request: TriageRequest): Promise<TriageResult>;
}
