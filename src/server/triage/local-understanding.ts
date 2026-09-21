import 'server-only';

import { includesUnnegated, normalise } from './red-flags';
import type { Specialty, TriageUrgency } from './types';

/**
 * What the built-in assistant can understand from a patient's words.
 *
 * Everything here is a list or a regular expression, on purpose. The built-in engine is
 * the one a clinic runs without a model vendor and without a BAA, so nothing leaves the
 * server. It is also deterministic, and a clinician can review this file in one sitting:
 * the same words always produce the same reading.
 *
 * It reads four things: which service the problem belongs to, how long it has been going
 * on, how bad it is, and what the patient is asking. It never reads a diagnosis, because
 * nothing downstream is allowed to say one.
 */

export type Rule = {
  specialty: Specialty;
  /** Phrases in the words patients use, lowercase and unpunctuated. Stems are fine. */
  any: string[];
  /** A noun phrase for the summary: "Here is what I understood: <topic>, …". */
  topic: string;
  /** Said once, when the problem is first understood. */
  ack: string;
  /** A short, plain sentence naming the service. Never a diagnosis. */
  because: string;
  /** What else to ask about, as examples. Answers go through the emergency check. */
  examples: string;
};

export const RULES: Rule[] = [
  {
    specialty: 'Dermatology',
    topic: 'a skin problem',
    ack: 'I am sorry you are dealing with a skin problem.',
    because: 'Skin problems are looked at by our dermatology service.',
    examples: 'it spreading, pain, or a fever',
    any: ['rash', 'skin', 'mole', 'acne', 'eczema', 'psoriasis', 'itchy', 'itching', 'spots', 'wart', 'hives', 'blister'],
  },
  {
    specialty: 'Cardiology',
    topic: 'heart or blood-pressure symptoms',
    ack: 'Thank you for telling me about this.',
    because: 'Heart and blood-pressure symptoms are looked at by our cardiology service.',
    examples: 'dizziness, feeling faint, or swollen ankles',
    any: ['palpitation', 'heart racing', 'irregular heartbeat', 'heartbeat', 'blood pressure', 'ankle swelling', 'breathless when walking'],
  },
  {
    specialty: 'Orthopaedics',
    topic: 'a bone, joint or muscle problem',
    ack: 'I am sorry you are dealing with this pain.',
    because: 'Bone, joint and muscle problems are looked at by our orthopaedic service.',
    examples: 'swelling, numbness, or not being able to put weight on it',
    any: ['joint', 'knee', 'shoulder', 'back pain', 'my back', 'hip', 'ankle', 'wrist', 'elbow', 'sprain', 'fracture', 'broken', 'muscle', 'neck pain', 'my neck'],
  },
  {
    specialty: 'Paediatrics',
    topic: 'your child being unwell',
    ack: 'I am sorry your child is unwell.',
    because: 'For a child, our paediatric service is the right place to start.',
    examples: 'a fever, not eating or drinking, or being unusually sleepy',
    any: ['my child', 'my son', 'my daughter', 'my baby', 'toddler', 'infant', 'my kid'],
  },
  {
    specialty: 'Obstetrics & gynaecology',
    topic: 'a gynaecology or pregnancy concern',
    ack: 'Thank you for telling me about this.',
    because: 'This is looked after by our obstetrics and gynaecology service.',
    examples: 'bleeding, a fever, or pain that is getting worse',
    any: ['period', 'menstrual', 'pregnan', 'vaginal', 'contracept', 'menopause', 'smear', 'fertility'],
  },
  {
    specialty: 'Ophthalmology',
    topic: 'an eye problem',
    ack: 'I am sorry you are having trouble with your eyes.',
    because: 'Eye symptoms are looked at by our eye service.',
    examples: 'pain, redness, or changes in your vision',
    any: ['eye', 'eyesight', 'vision', 'blurred', 'blurry', 'seeing double', 'floaters', 'eyelid'],
  },
  {
    specialty: 'Ear, nose & throat',
    topic: 'an ear, nose or throat problem',
    ack: 'I am sorry you are dealing with this.',
    because: 'Ear, nose and throat symptoms are looked at by our ENT service.',
    examples: 'a fever, trouble swallowing, or pain in your ear',
    any: ['ear', 'earache', 'hearing', 'sinus', 'nose', 'nosebleed', 'sore throat', 'throat', 'tonsil', 'hoarse', 'swallowing'],
  },
  {
    specialty: 'Gastroenterology',
    topic: 'a stomach or digestive problem',
    ack: 'I am sorry you are dealing with stomach trouble.',
    because: 'Digestive symptoms are looked at by our gastroenterology service.',
    examples: 'vomiting, diarrhoea, a fever, or blood when you go to the toilet',
    any: [
      'stomach', 'tummy', 'belly', 'abdominal', 'abdomen', 'nausea', 'nauseous', 'vomit',
      'throwing up', 'diarrh', 'constipat', 'bowel', 'heartburn', 'indigestion', 'bloating',
      'bloated',
    ],
  },
  {
    specialty: 'Neurology',
    topic: 'headaches or nerve symptoms',
    ack: 'I am sorry you are dealing with this.',
    because: 'Nerve and headache symptoms are looked at by our neurology service.',
    examples: 'numbness, weakness, or changes in your vision',
    /* "head" as a whole word, and the two commonest misspellings of "headache". */
    any: ['headache', 'hedache', 'headake', 'head', 'migraine', 'dizzy', 'dizziness', 'numbness', 'tingling', 'tremor', 'memory', 'balance', 'my head hurts'],
  },
  {
    specialty: 'Urology',
    topic: 'a urinary problem',
    ack: 'Thank you for telling me about this.',
    because: 'Urinary symptoms are looked at by our urology service.',
    examples: 'pain when you pee, blood in your urine, or a fever',
    any: ['urine', 'urinating', 'peeing', 'bladder', 'kidney', 'prostate', 'water works'],
  },
  {
    specialty: 'Mental health',
    topic: 'how you have been feeling',
    ack: 'I am sorry you are going through this, and thank you for telling me.',
    because: 'Our mental health team is the right place for this, and you can book directly.',
    examples: 'trouble sleeping, not eating, or it affecting your work or daily life',
    any: ['anxious', 'anxiety', 'depress', 'panic', 'stress', 'cannot sleep', 'insomnia', 'low mood', 'mood', 'lonely', 'sad all the time'],
  },
  {
    specialty: 'Dentistry',
    topic: 'a tooth or gum problem',
    ack: 'I am sorry you are dealing with tooth pain.',
    because: 'Teeth and gum problems are looked at by our dental service.',
    examples: 'swelling in your face or jaw, or a fever',
    any: ['tooth', 'teeth', 'toothache', 'dental', 'gum', 'jaw'],
  },
];

/** When nothing more specific fits. A GP can refer on, so this is never a dead end. */
export const GENERAL: Rule = {
  specialty: 'General practice',
  topic: 'your symptoms',
  ack: 'Thank you for telling me.',
  because: 'A GP appointment is the right place to start, and they can refer you on.',
  examples: 'a fever, or it getting worse',
  any: [],
};

/* ------------------------------------------------------------------ preparing text */

const CONTRACTIONS: [RegExp, string][] = [
  [/\bcant\b/g, 'cannot'],
  [/\bcan not\b/g, 'cannot'],
  [/\bdont\b/g, 'do not'],
  [/\bdoesnt\b/g, 'does not'],
  [/\bdidnt\b/g, 'did not'],
  [/\bwont\b/g, 'will not'],
  [/\bisnt\b/g, 'is not'],
  [/\bim\b/g, 'i am'],
  [/\bive\b/g, 'i have'],
];

/**
 * Lowercase, unpunctuated, contractions spelled out, so "I don't have a fever" reads as
 * "do not have a fever" and the negation check sees the "not".
 */
export function prepare(text: string): string {
  let prepared = normalise(text);
  for (const [pattern, replacement] of CONTRACTIONS) {
    prepared = prepared.replace(pattern, replacement);
  }
  return prepared;
}

/* ---------------------------------------------------------------- spelling mistakes */

/** True when `a` becomes `b` with one insert, delete, substitution or swap of neighbours. */
function oneEditApart(a: string, b: string): boolean {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;

  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;

  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // swap
  }
  const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
  return longer.slice(i + 1) === shorter.slice(i); // insert or delete
}

/**
 * The words a typo is corrected towards. A reviewed list, not every word in the rules,
 * because a target that is one letter from a common word turns that word into a symptom:
 * "sprain" would catch "spain", "hearing" would catch "heading", "belly" would catch
 * "bells". Each one here was checked for that, and each is matched by a rule above;
 * tests/integration/triage-conversation.test.ts holds the list to the second part.
 */
export const SPELLING_TARGETS: readonly string[] = [
  'stomach', 'abdomen', 'abdominal', 'nausea', 'nauseous', 'vomiting', 'diarrhea',
  'diarrhoea', 'constipated', 'constipation', 'indigestion', 'heartburn', 'bloating',
  'headache', 'migraine', 'dizziness', 'numbness', 'tingling',
  'eczema', 'psoriasis', 'itching', 'blister',
  'shoulder', 'fracture', 'muscle', 'elbow',
  'pregnant', 'period', 'menstrual', 'menopause',
  'anxiety', 'anxious', 'depressed', 'depression', 'insomnia',
  'palpitations', 'heartbeat',
  'urinating', 'bladder', 'kidney', 'prostate',
  'tonsils', 'throat', 'swallowing', 'earache', 'nosebleed',
  'toothache', 'eyelid', 'blurry', 'blurred', 'vision',
];

/**
 * Correct words that are one typo away from a symptom word, like "stomech" to "stomach".
 *
 * Only a FALLBACK. The caller tries the patient's own spelling first and uses this only
 * when that finds nothing, because a correction can be wrong ("spain" is one letter from
 * "sprain"), and a wrong correction must never outrank a word the patient actually wrote.
 * Same first letter and five letters or more, which is where real typos live and where
 * accidental matches between real words get rare.
 */
export function correctSpelling(prepared: string): string {
  return prepared
    .split(' ')
    .map((word) => {
      if (word.length < 5 || SPELLING_TARGETS.includes(word)) return word;
      const target = SPELLING_TARGETS.find((t) => t[0] === word[0] && oneEditApart(word, t));
      return target ?? word;
    })
    .join(' ');
}

/* ----------------------------------------------------------------------- complaint */

/**
 * Where `phrase` starts as a word in `haystack`, or -1.
 *
 * A match has to start a word, so "rash" is not found in "crash" and "ear" is not found in
 * "year". Short phrases also have to end one (a plural is allowed), because "ear" also
 * starts "early". Longer phrases may run on, which is what lets "vomit" find "vomiting".
 */
export function indexOfWord(haystack: string, phrase: string): number {
  for (
    let index = haystack.indexOf(phrase);
    index >= 0;
    index = haystack.indexOf(phrase, index + 1)
  ) {
    if (index > 0 && haystack[index - 1] !== ' ') continue;
    if (phrase.length <= 4 && !/^(s|es)?( |$)/.test(haystack.slice(index + phrase.length))) {
      continue;
    }
    return index;
  }
  return -1;
}

function earliestRule(haystack: string): Rule | null {
  let best: { rule: Rule; index: number } | null = null;
  for (const rule of RULES) {
    for (const phrase of rule.any) {
      const index = indexOfWord(haystack, phrase);
      /*
       * Earliest match wins. A patient leads with what is actually bothering them:
       * "my knee has hurt for weeks, and my skin is dry too" is an orthopaedic problem
       * with an aside, and counting keywords would answer dermatology.
       */
      if (index >= 0 && (best === null || index < best.index)) best = { rule, index };
    }
  }
  return best?.rule ?? null;
}

/** The service the problem belongs to, or null when nothing in the words points anywhere. */
export function readComplaint(prepared: string): Rule | null {
  return earliestRule(prepared) ?? earliestRule(correctSpelling(prepared));
}

/* ------------------------------------------------------------------------ duration */

const COUNT =
  '(\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a few|few|a couple of|a couple|couple of|several)';
const UNIT = '(minute|min|hour|hr|day|week|wk|month|year|yr)s?';
const SPAN = new RegExp(`\\b${COUNT} ${UNIT}\\b( ago)?`, 'g');
/** "3 times a day" is how often, not how long. */
const NOT_A_SPAN_AFTER = new Set(['times', 'once', 'twice', 'per', 'every']);

const SINCE =
  /\bsince (yesterday|last night|this morning|last week|last month|last year|monday|tuesday|wednesday|thursday|friday|saturday|sunday|the weekend)\b/;

const LOOSE: [RegExp, string][] = [
  [/\b(this morning|last night|yesterday)\b/, 'since $1'],
  [/\btoday\b/, 'since today'],
  [/\b(ages|a long time|a while|months|weeks|years)\b(?! old)/, 'for $1'],
];

/** How long, as a phrase for the summary ("for 3 days", "since yesterday"), or null. */
export function readDuration(prepared: string): string | null {
  for (const match of prepared.matchAll(SPAN)) {
    const before = prepared.slice(0, match.index).trim().split(' ').at(-1) ?? '';
    if (NOT_A_SPAN_AFTER.has(before)) continue;
    // "I am 40 years old" is an age.
    if (prepared.slice(match.index + match[0].length).startsWith(' old')) continue;
    const span = `${match[1]} ${match[2]}${match[1] === 'a' || match[1] === 'an' || match[1] === 'one' ? '' : 's'}`;
    return match[3] ? `started ${span} ago` : `for ${span}`;
  }
  const since = SINCE.exec(prepared);
  if (since) return since[0];
  for (const [pattern, template] of LOOSE) {
    const match = pattern.exec(prepared);
    if (match) return template.replace('$1', match[1] ?? '');
  }
  return null;
}

/* ------------------------------------------------------------------------ severity */

export type Severity = { score: number | null; word: 'mild' | 'moderate' | 'severe' };

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function wordFor(score: number): Severity['word'] {
  return score >= 7 ? 'severe' : score >= 4 ? 'moderate' : 'mild';
}

/**
 * How bad, from anything the patient wrote: "7/10", "7 out of 10", "unbearable".
 *
 * A bare number ("7") counts only as the answer to the severity question, which is why
 * that case takes `answeringSeverity`. Anywhere else, "7" is as likely to be days or
 * times a day, and misreading those as a pain score would move someone up or down the
 * queue for no reason.
 */
export function readSeverity(prepared: string, answeringSeverity: boolean): Severity | null {
  const outOfTen = /\b(10|[0-9]) (?:out of |of )?10\b/.exec(prepared);
  if (outOfTen) {
    const score = Math.max(1, Number(outOfTen[1]));
    return { score, word: wordFor(score) };
  }

  if (answeringSeverity) {
    const bare = /^(?:it is |its |about |around |maybe |like |a )*(10|[1-9]|one|two|three|four|five|six|seven|eight|nine|ten)\b(?! (?:minute|hour|day|week|month|year)s?\b)/.exec(
      prepared,
    );
    if (bare) {
      const score = WORD_NUMBERS[bare[1]!] ?? Number(bare[1]);
      return { score, word: wordFor(score) };
    }
  }

  // Milder phrases first: "not too bad" contains "bad".
  if (/\b(mild|slight|a little|not too bad|not that bad|not bad|not severe|manageable)\b/.test(prepared)) {
    return { score: null, word: 'mild' };
  }
  if (/\b(severe|very bad|really bad|terrible|awful|unbearable|excruciating|the worst|agony|extreme)\b/.test(prepared)) {
    return { score: null, word: 'severe' };
  }
  if (/\b(moderate|medium|quite bad|pretty bad|bad)\b/.test(prepared)) {
    return { score: null, word: 'moderate' };
  }
  return null;
}

/* ------------------------------------------------------------------------- urgency */

/** Phrases that move a problem up the queue without being emergencies. */
const URGENT_MARKERS = [
  'severe',
  'getting worse',
  'worsening',
  'much worse',
  'unbearable',
  'for weeks',
  'high fever',
  'cannot sleep because',
  'cannot walk',
  'cannot eat',
  'cannot put weight',
  'losing weight',
  'lump',
  'spreading',
  'blood in my urine',
  'blood in my pee',
  'blood in my stool',
  'blood in my poo',
  'black stool',
  'not eating',
  'not drinking',
  'unusually sleepy',
  'swollen face',
  'face is swollen',
];

/** Phrases that suggest something self-limiting, where booking may not be needed at all. */
const SELF_CARE_MARKERS = ['runny nose', 'common cold', 'mild', 'slight', 'just started today'];

/**
 * How soon, from everything the patient has said. Negated mentions do not count, so
 * "no fever, and it is not getting worse" stays routine.
 *
 * `urgentHint` is set when the patient answered "yes" to the question about other
 * symptoms without saying which. That resolves upward: not knowing which is not a reason
 * to wait.
 */
export function readUrgency(
  prepared: string,
  severity: Severity | null,
  urgentHint: boolean,
): TriageUrgency {
  if (URGENT_MARKERS.some((marker) => includesUnnegated(prepared, marker))) return 'urgent';
  if (severity?.word === 'severe' || urgentHint) return 'urgent';
  if (SELF_CARE_MARKERS.some((marker) => includesUnnegated(prepared, marker))) return 'self_care';
  return 'routine';
}

/* ------------------------------------------------------------------------- intents */

export type Intents = {
  greeting: boolean;
  thanks: boolean;
  bye: boolean;
  ok: boolean;
  yes: boolean;
  no: boolean;
  unsure: boolean;
  medicine: boolean;
  diagnosis: boolean;
  booking: boolean;
  human: boolean;
  identity: boolean;
  /** Opening hours, prices, address, phone: things only the clinic can state. */
  clinicInfo: boolean;
};

/**
 * What the patient is asking or saying, apart from symptoms.
 *
 * Medicine, diagnosis and booking count only as questions, which are messages with a "?"
 * or that start like one. "I took ibuprofen" is a fact about their day, and answering it
 * with "I cannot advise on medicines" would be talking past them.
 */
export function readIntents(raw: string): Intents {
  const text = prepare(raw);
  const asking =
    raw.includes('?') ||
    /^(what|which|can|could|should|is|are|do|does|how|when|where|will|would|may)\b/.test(text) ||
    /\b(can i|should i|could i|is it ok|is it safe|how much|how many)\b/.test(text);

  return {
    greeting: /^(hi|hello|hey|hiya|good (morning|afternoon|evening)|salam|salaam|assalamu alaikum|marhaba)\b/.test(text),
    thanks: /\b(thanks|thank you|thank u|thx|cheers|appreciate it)\b/.test(text),
    bye: /\b(bye|goodbye|see you|that is all|thats all|that is it|thats it)\b/.test(text),
    ok: /^(ok|okay|k|alright|all right|fine|cool|great|understood)( (thanks|thank you))?$/.test(text),
    /* The whole message, not its first word: "yes I have a fever" is an answer with content. */
    yes: /^(yes|yeah|yep|yup|ya|yah|y|sure|correct|i do)( i do)?$/.test(text),
    no: /^(no|nope|nah|none|nothing|not really|nothing else|i do not think so)( (thanks|thank you|thats all|that is all))?$/.test(
      text,
    ),
    unsure: /\b(not sure|do not know|idk|no idea|unsure|cannot say)\b/.test(text),
    medicine:
      asking &&
      /\b(medicine|medicines|medication|tablet|tablets|pill|pills|drug|drugs|ibuprofen|paracetamol|acetaminophen|aspirin|antibiotic|antibiotics|painkiller|painkillers|dose|dosage|prescription|what (can|should) i take|take (something|anything))\b/.test(
        text,
      ),
    diagnosis:
      /\b(what is (it|this|wrong)|what do i have|what could (it|this) be|what is causing)\b/.test(text) ||
      (asking && /\b(is (it|this) (serious|cancer|dangerous|bad)|diagnos)/.test(text)),
    booking:
      (asking && /\b(book|booking|appointment|see a doctor|see the doctor|see a gp)\b/.test(text)) ||
      /\b(i want to book|i would like to book|book me|make an appointment)\b/.test(text),
    human: /\b(real person|a human|talk to (a|someone|somebody|the)|speak to|call me|a nurse|receptionist|phone number)\b/.test(
      text,
    ),
    identity: /\b(who are you|are you (a )?(bot|robot|ai|human|real|doctor|person)|what are you)\b/.test(text),
    clinicInfo:
      asking &&
      /\b(open|opening|close|closed|hours|address|located|where are you|phone number|telephone|price|prices|cost|how much|fee|insurance|parking|saturday|sunday|weekend)\b/.test(
        text,
      ),
  };
}
