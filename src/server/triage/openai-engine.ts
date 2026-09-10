import 'server-only';

import {
  SPECIALTIES,
  isSpecialty,
  type Specialty,
  type TriageEngine,
  type TriageRequest,
  type TriageResult,
  type TriageUrgency,
} from './types';

/**
 * The third-party engine.
 *
 * ==========================================================================
 * ENABLING THIS IS A DISCLOSURE OF PHI. IT NEEDS A BAA.
 * ==========================================================================
 *
 * Everything sent here is a patient describing their own body, and the request also
 * carries the clinic's IP and, unavoidably, the timing of a specific patient's visit. That
 * is a disclosure to a business associate, and OpenAI will sign a BAA for API use on
 * eligible plans with zero data retention — but NOT on the free tier, which trains on
 * submitted data by default. A free-tier key is therefore the one configuration that must
 * not be used with real patients, and `env/server.ts` refuses to boot a production
 * deployment pointed at this engine without an explicit acknowledgement.
 *
 * WHAT THIS FILE DOES NOT SEND: any identifier. No name, no MRN, no date of birth, no
 * patient id, no conversation id. The model receives the symptom text and nothing that
 * ties it to a person — which does not make it non-PHI, but does mean a breach at the
 * vendor yields symptom paragraphs rather than a linkable patient record.
 *
 * NO SDK. Plain `fetch` against the REST endpoint: the official package is a large
 * dependency tree in a HIPAA application for the sake of one POST, and CLAUDE.md requires
 * asking before adding a library. Nothing here needs one.
 *
 * THE MODEL IS NOT TRUSTED. Its answer is parsed, and the specialty and urgency are
 * checked against closed sets; anything unrecognised falls back rather than reaching the
 * patient or the booking queue. The emergency check has already run before this file is
 * reached and cannot be overturned by anything the model says.
 */

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

const SYSTEM_PROMPT = [
  'You are a triage assistant for a medical clinic, talking directly to a patient.',
  'You do NOT diagnose, name conditions, or suggest medicines or doses.',
  'Reply in at most three short sentences, plain language, no lists, no markdown.',
  'Be warm but brief. Never claim a clinician has reviewed this.',
  `Choose exactly one specialty from this list: ${SPECIALTIES.join('; ')}.`,
  'Choose exactly one urgency from: urgent, routine, self_care.',
  'Respond ONLY as minified JSON: {"reply":string,"specialty":string,"urgency":string}',
].join(' ');

type OpenAiChoice = { message?: { content?: string } };
type OpenAiResponse = { choices?: OpenAiChoice[] };

function parse(content: string): Partial<TriageResult> {
  try {
    // Models wrap JSON in fences despite instructions; strip them before parsing.
    const cleaned = content
      .trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '')
      .trim();
    const raw: unknown = JSON.parse(cleaned);
    if (typeof raw !== 'object' || raw === null) return {};
    const obj = raw as Record<string, unknown>;
    return {
      reply: typeof obj['reply'] === 'string' ? obj['reply'] : undefined,
      specialty:
        typeof obj['specialty'] === 'string' && isSpecialty(obj['specialty'])
          ? obj['specialty']
          : undefined,
      urgency:
        obj['urgency'] === 'urgent' || obj['urgency'] === 'routine' || obj['urgency'] === 'self_care'
          ? obj['urgency']
          : undefined,
    };
  } catch {
    return {};
  }
}

export type OpenAiEngineOptions = {
  apiKey: string;
  model: string;
  /** Kept short: a patient staring at a spinner will refresh, and refresh again. */
  timeoutMs?: number;
};

export class OpenAiTriageEngine implements TriageEngine {
  readonly name: string;

  constructor(private readonly options: OpenAiEngineOptions) {
    this.name = `openai:${options.model}`;
  }

  async assess(request: TriageRequest): Promise<TriageResult> {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...request.history.map((turn) => ({
        role: turn.role === 'patient' ? 'user' : 'assistant',
        content: turn.body,
      })),
      { role: 'user', content: request.message },
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 12_000);

    let content = '';
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          messages,
          temperature: 0.2,
          max_tokens: 220,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        /*
         * The body can echo request content, so it is never logged or surfaced. Status
         * alone is enough to tell a bad key from a rate limit from an outage.
         */
        throw new Error(`triage upstream responded ${response.status}`);
      }

      const payload = (await response.json()) as OpenAiResponse;
      content = payload.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }

    const parsed = parse(content);

    /*
     * Fallbacks, not errors. If the model returns something unusable the patient still
     * gets a safe, honest answer and a route into the clinic — a spinner that ends in
     * "something went wrong" is the one outcome that leaves a symptomatic person with
     * nowhere to go.
     */
    const specialty: Specialty = parsed.specialty ?? 'General practice';
    const urgency: TriageUrgency = parsed.urgency ?? 'routine';
    const reply =
      parsed.reply?.trim() ||
      'Thanks — based on what you have described, a general practice appointment is the right place to start.';

    return { reply, urgency, specialty, engine: this.name };
  }
}
