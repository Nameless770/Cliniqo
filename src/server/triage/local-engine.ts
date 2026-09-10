import 'server-only';

import { normalise } from './red-flags';
import {
  type Specialty,
  type TriageEngine,
  type TriageRequest,
  type TriageResult,
  type TriageUrgency,
} from './types';

/**
 * The default engine: in-process, deterministic, no network.
 *
 * This is not a placeholder for the "real" one. It is the engine a clinic runs when it has
 * not signed a BAA with a model vendor, which is most clinics on most days, and the
 * feature has to be genuinely useful in that configuration rather than a disabled banner.
 *
 * What it actually does is narrow on purpose: map described symptoms onto one of the
 * clinic's services, and say how soon. It does not diagnose, does not explain, and does
 * not speculate — so the gap between this and a large model is much smaller than it looks,
 * because the useful output was never the prose.
 *
 * Being deterministic buys things a model cannot offer: the same input gives the same
 * recommendation every time, the mapping is reviewable by a clinician in one sitting, and
 * it cannot invent a specialty the practice does not run.
 */

type Rule = {
  specialty: Specialty;
  any: string[];
  /** A short, plain sentence naming what the clinic would look at. Never a diagnosis. */
  because: string;
};

const RULES: Rule[] = [
  {
    specialty: 'Dermatology',
    because: 'Skin problems are looked at by our dermatology service.',
    any: ['rash', 'skin', 'mole', 'acne', 'eczema', 'psoriasis', 'itchy', 'spots', 'wart', 'hives'],
  },
  {
    specialty: 'Cardiology',
    because: 'Heart and blood-pressure symptoms are looked at by our cardiology service.',
    any: ['palpitation', 'heart racing', 'irregular heartbeat', 'blood pressure', 'ankle swelling', 'breathless when walking'],
  },
  {
    specialty: 'Orthopaedics',
    because: 'Bone, joint and muscle problems are looked at by our orthopaedic service.',
    any: ['joint', 'knee', 'shoulder', 'back pain', 'hip', 'ankle', 'wrist', 'sprain', 'fracture', 'broken', 'muscle', 'neck pain'],
  },
  {
    specialty: 'Paediatrics',
    because: 'For a child, our paediatric service is the right place to start.',
    any: ['my child', 'my son', 'my daughter', 'my baby', 'toddler', 'infant', 'my kid'],
  },
  {
    specialty: 'Obstetrics & gynaecology',
    because: 'This is looked after by our obstetrics and gynaecology service.',
    any: ['period', 'menstrual', 'pregnan', 'vaginal', 'contracept', 'menopause', 'smear', 'fertility'],
  },
  {
    specialty: 'Ophthalmology',
    because: 'Eye symptoms are looked at by our eye service.',
    any: ['eye', 'vision', 'blurred', 'seeing double', 'floaters', 'eyelid'],
  },
  {
    specialty: 'Ear, nose & throat',
    because: 'Ear, nose and throat symptoms are looked at by our ENT service.',
    any: ['ear', 'hearing', 'sinus', 'nose', 'nosebleed', 'sore throat', 'tonsil', 'hoarse', 'swallowing'],
  },
  {
    specialty: 'Gastroenterology',
    because: 'Digestive symptoms are looked at by our gastroenterology service.',
    any: ['stomach', 'nausea', 'vomit', 'diarrh', 'constipat', 'bowel', 'heartburn', 'indigestion', 'bloating', 'abdominal'],
  },
  {
    specialty: 'Neurology',
    because: 'Nerve and headache symptoms are looked at by our neurology service.',
    any: ['headache', 'migraine', 'dizzy', 'dizziness', 'numbness', 'tingling', 'tremor', 'memory', 'balance'],
  },
  {
    specialty: 'Urology',
    because: 'Urinary symptoms are looked at by our urology service.',
    any: ['urine', 'urinating', 'peeing', 'bladder', 'kidney', 'prostate', 'water works'],
  },
  {
    specialty: 'Mental health',
    because: 'Our mental health team is the right place for this, and you can book directly.',
    any: ['anxious', 'anxiety', 'depress', 'panic', 'stress', 'cannot sleep', 'insomnia', 'low mood', 'mood'],
  },
  {
    specialty: 'Dentistry',
    because: 'Teeth and gum problems are looked at by our dental service.',
    any: ['tooth', 'teeth', 'dental', 'gum', 'jaw'],
  },
];

/** Phrases that move a routine problem up the queue without being emergencies. */
const URGENT_MARKERS = [
  'severe',
  'getting worse',
  'worsening',
  'unbearable',
  'for weeks',
  'high fever',
  'cannot sleep because',
  'cannot walk',
  'cannot eat',
  'losing weight',
  'lump',
];

/** Phrases that suggest something self-limiting, where booking may not be needed at all. */
const SELF_CARE_MARKERS = ['runny nose', 'common cold', 'mild', 'slight', 'just started today'];

function classify(haystack: string): { specialty: Specialty; because: string } {
  let best: { rule: Rule; index: number } | null = null;

  for (const rule of RULES) {
    for (const phrase of rule.any) {
      const index = haystack.indexOf(phrase);
      /*
       * Earliest match wins. A patient leads with what is actually bothering them —
       * "my knee has hurt for weeks, and my skin is dry too" is an orthopaedic problem
       * with an aside, and scoring by keyword count would answer dermatology.
       */
      if (index >= 0 && (best === null || index < best.index)) {
        best = { rule, index };
      }
    }
  }

  if (!best) {
    return {
      specialty: 'General practice',
      because: 'A GP appointment is the right place to start, and they can refer you on.',
    };
  }
  return { specialty: best.rule.specialty, because: best.rule.because };
}

function classifyUrgency(haystack: string): TriageUrgency {
  if (URGENT_MARKERS.some((m) => haystack.includes(m))) return 'urgent';
  if (SELF_CARE_MARKERS.some((m) => haystack.includes(m))) return 'self_care';
  return 'routine';
}

const URGENCY_SENTENCE: Record<TriageUrgency, string> = {
  emergency: '',
  urgent: 'Try to be seen in the next day or two.',
  routine: 'A routine appointment is fine.',
  self_care: 'This often settles on its own, but book if it lasts or gets worse.',
};

export class LocalTriageEngine implements TriageEngine {
  readonly name = 'local';

  assess(request: TriageRequest): Promise<TriageResult> {
    // The whole conversation, so a follow-up like "it is worse today" still classifies.
    const haystack = normalise(
      [...request.history.filter((t) => t.role === 'patient').map((t) => t.body), request.message].join(' '),
    );

    const { specialty, because } = classify(haystack);
    const urgency = classifyUrgency(haystack);

    const reply = [
      'Thanks — that helps.',
      because,
      URGENCY_SENTENCE[urgency],
      'This is not a diagnosis, and nobody has read this yet.',
    ]
      .filter(Boolean)
      .join(' ');

    return Promise.resolve({ reply, urgency, specialty, engine: this.name });
  }
}
