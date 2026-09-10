import 'server-only';

import { getEnv } from '@/env/server';

import { LocalTriageEngine } from './local-engine';
import { OpenAiTriageEngine } from './openai-engine';
import { detectRedFlag } from './red-flags';
import type { TriageEngine, TriageRequest, TriageResult } from './types';

export * from './types';
export { detectRedFlag, RED_FLAG_CODES } from './red-flags';

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

export type Assessment = TriageResult & {
  /** Set when the emergency path fired. The UI renders this very differently. */
  redFlagCode: string | null;
};

/**
 * Assess one message.
 *
 * `emergency` is not a severity here, it is a different outcome: no specialty worth
 * naming, no appointment worth booking, and no model call. The caller records it and shows
 * the instruction.
 */
export async function assessSymptoms(request: TriageRequest): Promise<Assessment> {
  const redFlag = detectRedFlag(request.message);
  if (redFlag) {
    return {
      reply: redFlag.message,
      urgency: 'emergency',
      /*
       * A specialty is still recorded because the column is not nullable in practice for
       * the front desk's queue, but it names the only correct destination rather than a
       * clinic service — nobody should book this.
       */
      specialty: 'General practice',
      engine: 'red-flag',
      redFlagCode: redFlag.code,
    };
  }

  const result = await getTriageEngine().assess(request);
  return { ...result, redFlagCode: null };
}
