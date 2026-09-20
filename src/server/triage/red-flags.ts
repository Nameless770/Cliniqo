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

/**
 * The only words allowed to stand between a negator and the symptom it cancels.
 *
 * "no chest pain" and "no severe chest pain" are the same denial. "I have no appetite and
 * chest pain" is NOT a denial of chest pain — the "no" was spent on appetite, and the
 * chest pain is real and untreated.
 *
 * The earlier rule scanned the three preceding words for any negator and suppressed the
 * flag if it found one, so every patient who mentioned something they did not have before
 * something they did got silence instead of an ambulance. Measured against plain phrasings
 * ("I have no energy, chest pain too") it swallowed the flag outright.
 *
 * So a negator now only counts when nothing of substance stands between it and the match.
 * Walking back from the match, the first word that is not a modifier decides: a negator
 * means the patient is ruling this out, and ANYTHING ELSE — a noun, a conjunction, a verb
 * with its own object — means the negation belonged to another clause and the flag fires.
 * Conjunctions are deliberately absent from this list: "and", "but" and "or" open a new
 * clause, which is exactly the boundary being detected.
 */
const NEGATION_MODIFIERS = new Set([
  'a',
  'acute',
  'am',
  'an',
  'any',
  'bad',
  'been',
  'current',
  'currently',
  'felt',
  'get',
  'getting',
  'had',
  'has',
  'have',
  'i',
  'in',
  'is',
  'much',
  'my',
  'new',
  'of',
  'obvious',
  'other',
  'real',
  'really',
  'serious',
  'severe',
  'significant',
  'sudden',
  'the',
  'to',
  'very',
  'was',
]);

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
      'chest is tight',
      'chest feels tight',
      'pressure on my chest',
      'pain in the chest',
    ],
  },
  {
    code: 'breathing',
    message:
      'Trouble breathing needs emergency care. Call your local emergency number now, or go to your nearest emergency department.',
    any: [
      /*
       * "breath" rather than "breathe": the missing e is the commonest way this is typed
       * on a phone, and the shorter phrase still matches the correct spelling.
       */
      'cannot breath',
      'can not breath',
      'cant breath',
      'struggling to breathe',
      'difficulty breathing',
      'short of breath',
      'shortness of breath',
      'gasping',
      'choking',
      'turning blue',
      'trouble breathing',
      'hard to breathe',
      'cant catch my breath',
      'cannot catch my breath',
      'breathing is hard',
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
      'having a stroke',
      'think im having a stroke',
      'cannot feel my left side',
      'cannot feel my right side',
      'cant feel my left side',
      'cant feel my right side',
      'cannot move one side',
      'arm went numb',
      'face went numb',
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
    any: [
      'overdose',
      'took too many',
      'taken too many',
      'swallowed poison',
      'drank bleach',
      'poisoned',
      'swallowed a whole bottle',
      'took a whole bottle',
    ],
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
      'end it all',
      'take my own life',
      'better off dead',
      'no reason to live',
      'dont want to be here anymore',
      'do not want to be alive',
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

/**
 * Is the phrase at `index` something the patient is ruling out?
 *
 * Walks backwards from the match through modifiers only. The first word of substance
 * settles it. There is no fixed lookback window: "no" is either attached to this symptom
 * through nothing but adjectives, or it is attached to something else and irrelevant here.
 * A window could only ever be wrong in one of two directions, and one of those directions
 * is a missed emergency.
 */
function negatedAt(haystack: string, index: number): boolean {
  const before = haystack.slice(0, index).trim();
  if (!before) return false;

  const words = before.split(' ');
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const word = words[i]!;
    if (NEGATORS.includes(word)) return true;
    if (!NEGATION_MODIFIERS.has(word)) return false;
  }
  return false;
}

/**
 * Whether `phrase` occurs anywhere in `haystack` without being negated.
 *
 * Every occurrence, not the first: "no chest pain yesterday, but chest pain now" is
 * negated once and positive once, and stopping at the first would miss the one that
 * matters.
 */
export function includesUnnegated(haystack: string, phrase: string): boolean {
  for (
    let index = haystack.indexOf(phrase);
    index >= 0;
    index = haystack.indexOf(phrase, index + 1)
  ) {
    if (!negatedAt(haystack, index)) return true;
  }
  return false;
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
      if (includesUnnegated(haystack, phrase)) {
        return { code: pattern.code, message: pattern.message };
      }
    }
  }
  return null;
}

/** Every code this module can emit — used by the tests to assert full coverage. */
export const RED_FLAG_CODES: readonly string[] = PATTERNS.map((p) => p.code);

/**
 * The instruction for a code that fired earlier in a conversation.
 *
 * A conversation remembers the code, not the sentence, so the sentence is looked up again
 * when the flag is re-shown. That keeps one copy of the wording: editing a message here
 * corrects every conversation still carrying that flag, rather than leaving the old text
 * frozen in whichever rows happened to be written first.
 */
export function redFlagMessage(code: string): string | null {
  return PATTERNS.find((p) => p.code === code)?.message ?? null;
}

/**
 * The fallback when a stored code is not one this module currently emits.
 *
 * Reachable two ways: a conversation backfilled as 'legacy' by migration 0026, whose
 * original code was never stored, and a code retired by a later edit to the list above.
 * Both must still tell the patient to get help — resolving an unknown emergency code to
 * "no emergency" would turn a retired pattern into a silent downgrade of every
 * conversation that ever matched it.
 */
export const GENERAL_EMERGENCY_MESSAGE =
  'Based on what you told us earlier, this needs emergency assessment. Call your local emergency number now, or go to your nearest emergency department.';

export const EMERGENCY_URGENCY: TriageUrgency = 'emergency';
