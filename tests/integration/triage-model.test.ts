import { afterEach, describe, expect, it, vi } from 'vitest';

import { __setTriageEngine, assessSymptoms } from '@/server/triage';
import { ModelTriageEngine, unsafeReply } from '@/server/triage/model-engine';

/**
 * The model engine.
 *
 * No network and no database: the server is a stub, which is the only way to assert what
 * this code does with a model that misbehaves — and misbehaving is the case that matters.
 * The patient's own words are part of the prompt, so "ignore your instructions" is an
 * input this application receives rather than a thought experiment.
 *
 * Every symptom here is synthetic (§164.514).
 */

function engine(content: string, options: { status?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: options.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  return {
    calls,
    model: new ModelTriageEngine({
      endpoint: 'http://localhost:11434/v1/chat/completions',
      model: 'test-model',
      label: 'model:test-model@localhost:11434',
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  __setTriageEngine(null);
});

describe('a model answering a patient', () => {
  const good = 'That sounds uncomfortable. How long has it been going on?';

  it("passes the model's words through, and routes with the rules", async () => {
    const { model } = engine(good);
    const result = await model.assess({ message: 'my stomach hurts', history: [] });

    expect(result.reply).toBe(good);
    /*
     * The routing is the built-in engine's, not the model's, because the routing is the
     * part anybody acts on: the front desk books from it. The label names both.
     */
    expect(result.specialty).toBe('Gastroenterology');
    expect(result.urgency).toBe('routine');
    expect(result.engine).toBe('model:test-model@localhost:11434+local:2');
  });

  it('sends the symptom text and the rules, and no identifier of any kind', async () => {
    const { model, calls } = engine(good);
    await model.assess({
      message: 'my stomach hurts',
      history: [{ role: 'assistant', body: 'What is bothering you today?' }],
    });

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.messages[0].role).toBe('system');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'my stomach hurts' });
    /*
     * The whole request, as a string. A patient id, MRN or name appearing anywhere in it —
     * including somewhere nobody thought to look, like a header or a model name — would be
     * a disclosure beyond the symptom text this engine is allowed to send.
     */
    const whole = JSON.stringify(calls[0]).toLowerCase();
    for (const forbidden of ['patient_id', 'patientid', 'mrn', 'date_of_birth', 'conversationid']) {
      expect(whole).not.toContain(forbidden);
    }
  });

  it('sends no authorization header without a key, and a bearer token with one', async () => {
    const { model, calls } = engine(good);
    await model.assess({ message: 'my stomach hurts', history: [] });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();

    vi.unstubAllGlobals();
    const second = engine(good);
    const keyed = new ModelTriageEngine({
      endpoint: 'https://example.invalid/v1/chat/completions',
      model: 'test-model',
      apiKey: 'synthetic-key',
      label: 'model:test-model@example.invalid',
    });
    await keyed.assess({ message: 'my stomach hurts', history: [] });
    expect((second.calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer synthetic-key',
    );
  });

  it('takes the sentence out when the model answers in JSON anyway', async () => {
    /* Asked for plain text, small models still sometimes wrap it. The patient must not be
       shown braces. */
    const { model } = engine('```json\n{"reply":"Tell me more."}\n```');
    const result = await model.assess({ message: 'my head hurts', history: [] });

    expect(result.reply).toBe('Tell me more.');
    expect(result.specialty).toBe('Neurology');
  });

  it('never lets the model choose the service, even when it names one', async () => {
    const { model } = engine('You should see a cardiologist about this.');
    const result = await model.assess({ message: 'my stomach hurts', history: [] });

    /* A clinic cannot book against a service it does not run, and the rules cannot name
       one that it does not. */
    expect(result.specialty).toBe('Gastroenterology');
  });

  it('ignores a wall of text rather than pasting it to a patient', async () => {
    const { model } = engine('x'.repeat(900));
    const result = await model.assess({ message: 'my stomach hurts', history: [] });

    expect(result.reply).not.toContain('xxxx');
    expect(result.engine).toContain('refused-empty');
  });
});

describe('a model that says something the clinic will not send', () => {
  const cases: [string, string][] = [
    ['medicine', 'Take some ibuprofen and rest.'],
    ['dose', 'Try 400 mg twice a day.'],
    ['diagnosis', 'It sounds like you have appendicitis.'],
    ['impersonation', 'Your message has been reviewed by a doctor.'],
    ['clinic_facts', 'Our clinic is closed on Saturdays, but we have a 24-hour phone line.'],
  ];

  it.each(cases)('refuses it by the %s rule', async (rule, reply) => {
    expect(unsafeReply(reply)).toBe(rule);

    const { model } = engine(reply);
    const result = await model.assess({ message: 'my stomach hurts', history: [] });

    /* The patient gets the built-in engine's answer instead — never the refused text. */
    expect(result.reply).not.toContain(reply);
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.engine).toBe(`model:test-model@localhost:11434-refused-${rule}`);
  });

  it('lets ordinary sentences through, including the clinic\'s own disclaimers', () => {
    expect(unsafeReply('A pharmacist can advise on what is safe to take.')).toBeNull();
    expect(unsafeReply('How bad is it, from 1 to 10?')).toBeNull();
    /*
     * The regression this pins. The rule used to match the word "diagnosis", so it
     * refused the sentence this application ends its own suggestions with — every safe
     * reply thrown away, every turn answered by the fallback. Caught by running the guard
     * against a real model rather than against the examples it was written from.
     */
    expect(unsafeReply('This is not a diagnosis, and nobody has read this yet.')).toBeNull();
    expect(unsafeReply('I cannot tell you what it is. Only a clinician can.')).toBeNull();
    expect(unsafeReply('I am not able to diagnose anything.')).toBeNull();
    /* While a model actually claiming one is still refused. */
    expect(unsafeReply('My diagnosis is appendicitis.')).toBe('diagnosis');
    expect(unsafeReply('You probably have a kidney infection.')).toBe('diagnosis');
  });
});

describe('a model that is unavailable', () => {
  it('never leaks the upstream body, and the built-in assistant answers instead', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response('{"error":{"message":"my stomach hurts is invalid"}}', { status: 500 }),
      ),
    );

    const model = new ModelTriageEngine({
      endpoint: 'http://localhost:11434/v1/chat/completions',
      model: 'test-model',
      label: 'model:test-model@localhost:11434',
    });

    await expect(model.assess({ message: 'my stomach hurts', history: [] })).rejects.toThrow(
      /responded 500/,
    );
    /* The status, and nothing that came back with it. */
    await expect(
      model.assess({ message: 'my stomach hurts', history: [] }),
    ).rejects.not.toThrow(/stomach/);

    /*
     * And through the orchestrator: an outage costs the model's prose, not the patient's
     * answer. The engine recorded on the row says which one actually spoke.
     */
    __setTriageEngine(model);
    const assessment = await assessSymptoms({
      message: 'my stomach hurts',
      history: [],
    });
    expect(assessment.reply).toMatch(/stomach|how long/i);
    expect(assessment.engine).toBe('local:2-after-model:test-model@localhost:11434');
    expect(assessment.urgency).not.toBeUndefined();
  });

  it('still refuses to let an engine answer an emergency at all', async () => {
    let called = false;
    __setTriageEngine({
      name: 'must-not-run',
      assess: () => {
        called = true;
        throw new Error('the engine must not be consulted for a red flag');
      },
    });

    const result = await assessSymptoms({
      message: 'I have crushing chest pain',
      history: [],
    });

    expect(called).toBe(false);
    expect(result.urgency).toBe('emergency');
    expect(result.engine).toBe('red-flag');
  });
});
