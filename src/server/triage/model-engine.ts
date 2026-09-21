import 'server-only';

import { converse } from './local-engine';
import type { TriageEngine, TriageRequest, TriageResult } from './types';

/**
 * A language model, over the OpenAI chat-completions shape.
 *
 * ==========================================================================
 * WHERE THE MODEL RUNS DECIDES WHETHER THIS IS A DISCLOSURE OF PHI
 * ==========================================================================
 *
 * One adapter, because the protocol is the same whether it is answered by a vendor's API
 * or by Ollama on the clinic's own machine — and those two are not the same act. A model
 * on this machine reads the symptom text inside the building the patient already trusted
 * with it: no business associate, no BAA, no bill. Any other host receives PHI, and
 * `env/server.ts` refuses to boot such a configuration without an explicit acknowledgement
 * that a BAA covers it. A free tier is not an exception to that; it is usually the worst
 * case of it, because free tiers train on what they are sent.
 *
 * WHAT IS SENT: the symptom text and the assistant's own turns. No name, no MRN, no date
 * of birth, no patient id, no conversation id. That does not make it non-PHI, but it means
 * a breach at the other end yields symptom paragraphs rather than a linkable record.
 *
 * NO SDK. Plain `fetch` against one endpoint: a vendor SDK is a large dependency tree in a
 * HIPAA application for the sake of one POST, and CLAUDE.md requires asking before adding
 * a library.
 *
 * THE MODEL IS NOT TRUSTED, IN EITHER DIRECTION.
 *  - Its routing is checked against closed sets; anything unrecognised falls back.
 *  - Its words are checked by `unsafeReply` below, because the patient's own message is
 *    part of the prompt and a patient can ask a model to ignore its instructions. A reply
 *    that names a medicine, a dose or a diagnosis, or that claims a clinician has read the
 *    conversation, is thrown away and the built-in engine answers that turn instead.
 *  - The emergency check has already run, deterministically, before this file is reached,
 *    and nothing here can overturn it (see index.ts).
 */

const SYSTEM_PROMPT = [
  'You are the automated assistant of a medical clinic, chatting with a patient.',
  'Talk like a person: answer what they actually said, in plain, warm, simple language.',
  'Hard rules you never break:',
  '1. You are not a clinician. Never diagnose, never name a condition, never say what is causing something.',
  '2. Never name a medicine, a dose or a treatment. Point to a pharmacist or a clinician instead.',
  '3. Never say or imply that a human has read this conversation.',
  '4. Only if they describe something immediately dangerous, tell them to call their local emergency number. Never say it for an ordinary symptom.',
  '5. Do not say which service or specialist to book. The clinic works that out and shows it under the chat.',
  '6. At most three short sentences. No lists, no markdown, no emoji, no JSON.',
  '7. Ask at most one question per reply, and only if it helps the clinic understand the problem.',
  '8. You do NOT know this clinic: not its opening hours, phone numbers, prices, addresses or staff. Never state any of them. Say that the clinic\'s own page or reception can tell them.',
  '9. You cannot book, move or cancel anything. The booking link under the chat does that.',
  '10. If they ask something unrelated to health, answer it in one friendly sentence, then return to how you can help.',
  'Reply with those sentences and nothing else.',
].join('\n');

/**
 * Replies the clinic will not send, whatever the model produced.
 *
 * Deliberately blunt. Each pattern is something that would be wrong coming from an
 * automated assistant no matter how well phrased, and a false positive costs one turn of
 * model prose — the built-in engine answers instead, and the patient still gets help.
 */
const FORBIDDEN: [string, RegExp][] = [
  ['dose', /\b\d+\s?(mg|mcg|ml|g|iu)\b/i],
  [
    'medicine',
    /\b(ibuprofen|paracetamol|acetaminophen|aspirin|naproxen|codeine|amoxicillin|antibiotics?|antihistamines?|painkillers?|omeprazole|ranitidine|prednisolone|steroids?)\b/i,
  ],
  [
    /*
     * Claims, not the word. "This is not a diagnosis, and nobody has read this yet" is
     * the disclaimer this application itself ends on, and a rule that matched `diagnos`
     * refused every safe reply that said so — found by pointing the guard at a real
     * model. What must never appear is a model telling somebody what they have.
     */
    'diagnosis',
    /\b(my diagnosis|diagnosis is|i (can )?diagnose|you are suffering from|it sounds like you have|you (most likely|probably|definitely) have|you appear to have|this is probably (a|an))\b/i,
  ],
  [
    'impersonation',
    /\b(i am a (doctor|nurse|clinician)|as your (doctor|clinician)|(reviewed|read|checked) by (a|our|the) (doctor|clinician|nurse))\b/i,
  ],
  [
    /*
     * Facts about the clinic are the clinic's to state. A model asked "are you open on
     * Saturday?" answers confidently and wrongly — the first live run replied "our clinic
     * is closed on Saturdays, but we have a 24-hour phone line", which is not true of any
     * clinic this application knows about, and a patient could act on it.
     */
    'clinic_facts',
    /\b((we|the clinic|our clinic|the practice) (is|are|will be)?\s?(open|closed)|opening hours|office hours|24[- ]hour|call us on|phone us on|costs? \$?\d|£\d|\$\d|\b\d{3}[- ]\d{3,4}\b)/i,
  ],
];

export function unsafeReply(reply: string): string | null {
  for (const [rule, pattern] of FORBIDDEN) if (pattern.test(reply)) return rule;
  return null;
}

type ChatResponse = { choices?: { message?: { content?: string } }[] };

/** The model's words, with the decoration small models add: fences, quotes, a JSON wrapper. */
function readReply(content: string): string {
  let text = content.replace(/```(?:json)?/gi, '').trim();

  /*
   * Some models answer in JSON anyway, whatever the prompt says. Take the sentence out,
   * under whichever key they used — a patient must never be shown braces.
   */
  if (text.startsWith('{')) {
    try {
      const obj: unknown = JSON.parse(text.slice(0, text.lastIndexOf('}') + 1));
      const fields = Object.values((obj ?? {}) as Record<string, unknown>);
      const sentence = fields.find((v) => typeof v === 'string' && v.trim().length > 0);
      text = typeof sentence === 'string' ? sentence.trim() : '';
    } catch {
      text = '';
    }
  }

  text = text.replace(/^"|"$/g, '').trim();
  /* A wall of text is a model that has ignored the brief; the built-in engine is better. */
  return text.length > 800 ? '' : text;
}

export type ModelEngineOptions = {
  /** The full chat-completions URL, vendor or local. */
  endpoint: string;
  model: string;
  /** Local servers need none; sent as a bearer token when present. */
  apiKey?: string | undefined;
  /** Recorded on the conversation, so a stored recommendation stays interpretable. */
  label: string;
  /** Kept short: a patient staring at a spinner will refresh, and refresh again. */
  timeoutMs?: number;
  /** How many earlier turns to send. The thread itself can be much longer. */
  historyTurns?: number;
};

export class ModelTriageEngine implements TriageEngine {
  readonly name: string;

  constructor(private readonly options: ModelEngineOptions) {
    this.name = options.label;
  }

  async assess(request: TriageRequest): Promise<TriageResult> {
    const history = request.history.slice(-(this.options.historyTurns ?? 12));
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.map((turn) => ({
        role: turn.role === 'patient' ? 'user' : 'assistant',
        content: turn.body,
      })),
      { role: 'user', content: request.message },
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000);

    let content = '';
    try {
      const response = await fetch(this.options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey
            ? { authorization: `Bearer ${this.options.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: this.options.model,
          messages,
          temperature: 0.3,
          max_tokens: 300,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        /*
         * The body can echo the request, which is the patient's symptom text, so it is
         * never logged or surfaced. The status alone separates a bad key from a model that
         * is not loaded from an outage.
         */
        throw new Error(`triage model responded ${response.status}`);
      }

      const payload = (await response.json()) as ChatResponse;
      content = payload.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }

    const reply = readReply(content);
    const violation = reply ? unsafeReply(reply) : 'empty';

    /*
     * THE ROUTING IS NEVER THE MODEL'S.
     *
     * The front desk books from `specialty` and sorts its queue by `urgency`, and those
     * two are the only parts of this feature anybody acts on. They come from the built-in
     * rules: deterministic, reviewable by a clinician in one sitting, unable to invent a
     * service the practice does not run, and identical whether a model is configured or
     * not. The model contributes the words and nothing else.
     *
     * It is also what a 3B model actually does well. Asked for JSON with a specialty in
     * it, the first live run answered in prose every time and every conversation landed
     * on "General practice"; asked only to talk, it talks, and the rules route.
     */
    const routed = converse(request);

    if (violation) {
      /*
       * The model said something the clinic will not send, so the built-in engine answers
       * this turn too. The patient is never shown an error for it — they are mid-sentence
       * about their own body — and the row records which rule fired, never the words.
       */
      console.warn(`[triage] model reply refused by the ${violation} rule`);
      return { ...routed, engine: `${this.name}-refused-${violation}` };
    }

    return {
      reply,
      specialty: routed.specialty,
      urgency: routed.urgency,
      /* Words from the model, routing from the rules — both named, so a stored row says so. */
      engine: `${this.name}+${routed.engine}`,
    };
  }
}
