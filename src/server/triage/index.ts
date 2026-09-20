import 'server-only';

import { getEnv } from '@/env/server';

import { LocalTriageEngine } from './local-engine';
import { OpenAiTriageEngine } from './openai-engine';
import { detectRedFlag, GENERAL_EMERGENCY_MESSAGE, redFlagMessage } from './red-flags';
import type { TriageEngine, TriageRequest, TriageResult } from './types';

export * from './types';
export { detectRedFlag, GENERAL_EMERGENCY_MESSAGE, RED_FLAG_CODES } from './red-flags';

/**
 * The triage entry point, and the order of operations that makes it safe.
 *
 *   1. Emergency detection, deterministic, on the patient's raw words.
 *   2. Only if that is clear, the configured engine.
 *
 * Step 1 never delegates and step 2 can never overturn it. Everything else in this
 * feature is a detail; that ordering is the feature.
 */

let cached: TriageEngine | null = null;

/**
 * The engine for this process.
 *
 * Built once and memoised — not for speed, but so the choice is made from validated
 * configuration at first use rather than re-derived per request, where a half-set
 * environment could silently change which vendor a patient's symptoms go to between two
 * messages in the same conversation.
 */
export function getTriageEngine(): TriageEngine {
  if (cached) return cached;

  const env = getEnv();
  if (env.TRIAGE_ENGINE === 'openai') {
    /*
     * `env` has already refused to validate if the key is missing or the BAA has not been
     * acknowledged, so reaching here means an operator made that decision explicitly.
     */
    cached = new OpenAiTriageEngine({
      apiKey: env.OPENAI_API_KEY!,
      model: env.OPENAI_MODEL,
    });
  } else {
    cached = new LocalTriageEngine();
  }
  return cached;
}

/** Test seam. Not exported from the package's public surface in application code. */
export function __setTriageEngine(engine: TriageEngine | null): void {
  cached = engine;
}

const STILL_AN_EMERGENCY =
  'What you described earlier needs help straight away. Please do not wait for an appointment: call your local emergency number or crisis line now, or go to your nearest emergency department. If you wrote that by mistake, start a new conversation.';

export type Assessment = TriageResult & {
  /** Set when the emergency path fired. The UI renders this very differently. */
  redFlagCode: string | null;
  /**
   * True when the flag came from earlier in the conversation rather than from this
   * message. Recorded in the audit metadata so "when did this become an emergency" is
   * answerable from the log, which is the question an incident review asks first.
   */
  redFlagStanding: boolean;
};

/**
 * An emergency already raised by this conversation, carried on the conversation row.
 *
 * Passed in rather than re-derived, because the history handed to `assess` is capped and
 * the flag must outlive that cap. See `triage_conversation.red_flag_code`.
 */
export type AssessOptions = { standingRedFlagCode?: string | null };

/** The instruction for a code, falling back to the general one for anything unrecognised. */
function messageForCode(code: string): string {
  return redFlagMessage(code) ?? GENERAL_EMERGENCY_MESSAGE;
}

/**
 * Assess one message.
 *
 * `emergency` is not a severity here, it is a different outcome: no specialty worth
 * naming, no appointment worth booking, and no model call. The caller records it and shows
 * the instruction.
 *
 * An emergency is never WITHDRAWN. Three things can raise one — this message, an earlier
 * message still inside the history window, or a flag already standing on the conversation
 * — and any of them short-circuits the engine. A patient who described chest pain and then
 * mentioned a sore knee has a chest pain problem and a sore knee, not a knee problem, and
 * the older design answered the second message as though the first had never happened.
 */
export async function assessSymptoms(
  request: TriageRequest,
  options: AssessOptions = {},
): Promise<Assessment> {
  /*
   * A standing emergency is re-stated, not re-quoted.
   *
   * Repeating the full chest-pain instruction after every "ok" is noise, and noise is how
   * a banner stops being read. The follow-up wording says the same thing once and tells
   * someone who typed the alarm by mistake how to get out of it.
   */
  const emergency = (code: string | null, standing: boolean): Assessment => ({
    reply: standing ? STILL_AN_EMERGENCY : messageForCode(code!),
    urgency: 'emergency',
    /*
     * A specialty is still recorded because the column is not nullable in practice for
     * the front desk's queue, but it names the only correct destination rather than a
     * clinic service — nobody should book this.
     */
    specialty: 'General practice',
    engine: 'red-flag',
    redFlagCode: code,
    redFlagStanding: standing,
  });

  /* This message first, so the freshest emergency is the one quoted back in full. */
  const current = detectRedFlag(request.message);
  if (current) return emergency(current.code, false);

  /* Then the conversation's own history, newest first. */
  for (let i = request.history.length - 1; i >= 0; i -= 1) {
    const turn = request.history[i]!;
    if (turn.role !== 'patient') continue;
    const earlier = detectRedFlag(turn.body);
    if (earlier) return emergency(earlier.code, true);
  }

  /*
   * Finally a standing emergency the caller knows about, which is what survives beyond
   * the ten-turn history window.
   *
   * Two inputs, deliberately. `standingRedFlagCode` comes from the conversation row and
   * carries WHICH emergency, so the audit trail keeps naming it; `alreadyEmergency` is
   * the weaker signal derived from the stored urgency, and covers a row whose code is
   * unknown — a conversation that predates the column, or one whose urgency was set by
   * some future path that does not write a code. Either is enough to refuse to downgrade.
   */
  const standingCode = options.standingRedFlagCode ?? null;
  if (standingCode || request.alreadyEmergency) return emergency(standingCode, true);

  const result = await getTriageEngine().assess(request);
  return { ...result, redFlagCode: null, redFlagStanding: false };
}
