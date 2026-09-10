import 'server-only';

import type { TriageUrgency } from './types';

/**
 * Emergency detection.
 *
 * ==========================================================================
 * THIS RUNS BEFORE ANY MODEL, AND ITS ANSWER IS FINAL
 * ==========================================================================
 *
 * If a patient types that their chest hurts and they cannot breathe, the correct response
 * is "call an ambulance" — every time, on the worst day, with the network down, with the
 * API key expired, with the model in a bad mood. A language model cannot make that
 * promise: it is a probability distribution, and the failure it can produce here is
 * someone dying at home because a paragraph sounded reassuring.
 *
 * So this is a hardcoded list, matched deterministically, evaluated first, and when it
 * fires nothing else runs. The model is never consulted, never sees the text, and cannot
 * overturn the result. That inversion — safety logic above the intelligence rather than
 * inside it — is the whole design.
 *
 * BIAS IS DELIBERATELY TOWARD OVER-TRIAGE. The two failure directions are not
 * symmetrical: a false positive sends someone to A&E who did not need to go, and a false
 * negative kills them. Every ambiguous phrase resolves upward, and that is not a
 * limitation to be tuned away later.
 *
 * NOT A MEDICAL DEVICE, and the way it stays out of that category is that it never
 * diagnoses and never tells anyone to stay home: the only outcomes are "get emergency
 * help now" and "here is which clinic service to book". A patient is always free to
 * ignore it and book anyway.
 */

export type RedFlag = {
  /** What matched, for the audit metadata. Never the patient's own words. */
  code: string;
  /** Shown to the patient, verbatim. Plain, short, imperative. */
  message: string;
};

/**
 * Words that flip a match off.
 *
 * "no chest pain" and "denies shortness of breath" are the phrases of someone ruling
 * things out, and firing an ambulance banner at them trains people to ignore the banner —
 * which is how a real one gets ignored later. Only immediate negation counts; anything
 * cleverer would start guessing, and guessing is what this file exists to avoid.
 */
const NEGATORS = ['no', 'not', 'never', 'without', 'denies', 'deny', 'havent', 'hasnt'];

type Pattern = { code: string; message: string; any: string[] };

/**
 * The list.
 *
 * Phrases, not single words, wherever a single word would be ambiguous — "bleeding" is
 * routine, "bleeding that will not stop" is not. Written in the words patients use, not
 * in clinical vocabulary, because the input is a patient typing on their phone.
 */
const PATTERNS: Pattern[] = [
  {
    code: 'cardiac',
    message:
      'Chest pain can be a heart attack. Call your local emergency number now, or go to your nearest emergency department. Do not drive yourself.',
    any: [
      'chest pain',
      'chest hurts',
      'pain in my chest',
      'chest tightness',
      'tight chest',
      'pressure in my chest',
      'crushing chest',
      'heart attack',
      'pain in my left arm',
      'chest pain and sweating',
    ],
  },
  {
    code: 'breathing',
    message:
      'Trouble breathing needs emergency care. Call your local emergency number now, or go to your nearest emergency department.',
    any: [
      'cannot breathe',
      'can not breathe',
      'cant breathe',
      'struggling to breathe',
      'difficulty breathing',
      'short of breath',
      'shortness of breath',
      'gasping',
      'choking',
      'turning blue',
    ],
  },
  {
    code: 'stroke',
    message:
      'These can be signs of a stroke, where minutes matter. Call your local emergency number now. Do not wait to see if it passes.',
    any: [
      'face is drooping',
      'face drooping',
      'droopy face',
      'slurred speech',
      'cannot speak',
      'cant speak',
      'weakness on one side',
      'numb on one side',
      'one side of my body',
      'sudden confusion',
      'worst headache of my life',
      'sudden severe headache',
      'thunderclap headache',
    ],
  },
  {
    code: 'anaphylaxis',
    message:
      'This can be a severe allergic reaction. Use an adrenaline pen if you have one and call your local emergency number now.',
    any: [
      'throat closing',
      'throat is closing',
      'tongue swelling',
      'lips swelling',
      'face swelling',
      'anaphylaxis',
      'severe allergic reaction',
      'hives all over',
    ],
  },
  {
    code: 'haemorrhage',
    message:
      'Bleeding that will not stop needs emergency care. Apply firm pressure and call your local emergency number now.',
    any: [
      'bleeding heavily',
      'heavy bleeding',
      'bleeding will not stop',
      'bleeding wont stop',
      'cannot stop the bleeding',
      'vomiting blood',
      'coughing up blood',
      'blood in my vomit',
    ],
  },
  {
    code: 'consciousness',
    message:
      'Loss of consciousness or a seizure needs emergency assessment. Call your local emergency number now.',
    any: [
      'passed out',
      'blacked out',
      'lost consciousness',
      'unconscious',
      'unresponsive',
      'having a seizure',
      'had a seizure',
      'fitting',
      'convulsions',
    ],
  },
  {
    code: 'poisoning',
    message:
      'Call your local emergency number or your poisons helpline now, and take the packaging with you if you can.',
    any: ['overdose', 'took too many', 'swallowed poison', 'drank bleach', 'poisoned'],
  },
  {
    code: 'obstetric',
    message:
      'Bleeding or severe pain in pregnancy needs urgent assessment. Contact your maternity unit or emergency number now.',
    any: [
      'bleeding and pregnant',
      'pregnant and bleeding',
      'pregnant and severe pain',
      'waters broke',
      'no fetal movement',
      'baby not moving',
    ],
  },
  {
    code: 'vision',
    message:
      'Sudden loss of vision needs emergency eye assessment. Go to your nearest emergency department now.',
    any: ['lost my vision', 'sudden vision loss', 'went blind', 'cannot see out of'],
  },
  {
    code: 'infant_fever',
    message:
      'A fever in a baby this young needs to be seen urgently. Contact your emergency number or out-of-hours service now.',
    any: [
      'newborn with a fever',
      'baby has a fever',
      'fever in my newborn',
      'rash that does not fade',
      'rash that doesnt fade',
      'glass test',
    ],
  },
  {
    /*
     * Not an ambulance, but never a "book an appointment" either. Routing someone in
     * crisis into a booking queue is the worst outcome this feature could produce, so it
     * short-circuits like the rest and hands over a crisis line instead.
     */
    code: 'self_harm',
    message:
      'Please talk to someone now. Contact your local crisis line or emergency number, or go to your nearest emergency department. You do not have to wait for an appointment.',
    any: [
      'kill myself',
      'end my life',
      'want to die',
      'suicidal',
      'suicide',
      'hurt myself',
      'harm myself',
      'self harm',
    ],
  },
];

/** Lowercase, strip punctuation and apostrophes, collapse whitespace. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function negatedAt(haystack: string, index: number): boolean {
  const before = haystack.slice(Math.max(0, index - 24), index).trim().split(' ');
  // Only the three words immediately before count — "no" ten words back is another clause.
  return before.slice(-3).some((w) => NEGATORS.includes(w));
}

/**
 * The first red flag the text matches, or null.
 *
 * First rather than all: the patient gets one instruction, and a wall of emergency
 * banners is a wall nobody reads.
 */
export function detectRedFlag(text: string): RedFlag | null {
  const haystack = normalise(text);
  if (!haystack) return null;

  for (const pattern of PATTERNS) {
    for (const phrase of pattern.any) {
      const index = haystack.indexOf(phrase);
      if (index >= 0 && !negatedAt(haystack, index)) {
        return { code: pattern.code, message: pattern.message };
      }
    }
  }
  return null;
}

/** Every code this module can emit — used by the tests to assert full coverage. */
export const RED_FLAG_CODES: readonly string[] = PATTERNS.map((p) => p.code);

export const EMERGENCY_URGENCY: TriageUrgency = 'emergency';
