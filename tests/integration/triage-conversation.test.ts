import { describe, expect, it } from 'vitest';

import {
  __setTriageEngine,
  assessSymptoms,
  detectRedFlag,
  type TriageEngine,
} from '@/server/triage';
import { converse } from '@/server/triage/local-engine';
import {
  SPELLING_TARGETS,
  readComplaint,
  readDuration,
  readSeverity,
} from '@/server/triage/local-understanding';
import type { TriageResult, TriageTurn } from '@/server/triage/types';

/**
 * The built-in assistant, as a conversation.
 *
 * Pure: no database and no network, which is the point of this engine. Each test plays a
 * thread the way the portal does, feeding every reply back in as history, and checks what
 * a patient would see and what the front desk would be told.
 *
 * What is NOT claimed here is that the suggestions are clinically right. What is claimed
 * is that the conversation always moves forward, never asks the same thing twice, never
 * names a medicine or a condition, and resolves doubt upward.
 */

function chat(...messages: string[]): { last: TriageResult; replies: string[] } {
  const history: TriageTurn[] = [];
  const replies: string[] = [];
  let last: TriageResult | null = null;
  for (const message of messages) {
    last = converse({ message, history });
    replies.push(last.reply);
    history.push(
      { role: 'patient', body: message },
      { role: 'assistant', body: last.reply },
    );
  }
  return { last: last!, replies };
}

describe('the built-in assistant, holding a conversation', () => {
  it('understands "stomech", then asks how long, how bad and what else, then suggests', () => {
    const { last, replies } = chat('i have stomech pain', '3 days', '7', 'no');

    expect(replies[0]).toMatch(/stomach trouble/i);
    expect(replies[0]).toMatch(/how long has this been going on/i);
    expect(replies[1]).toMatch(/how bad is it right now/i);
    expect(replies[2]).toMatch(/anything else happening with it, like vomiting/i);
    expect(replies[3]).toMatch(/my suggestion:/i);
    expect(replies[3]).toMatch(/for 3 days/);
    expect(replies[3]).toMatch(/rated 7 out of 10/);
    expect(replies[3]).toMatch(/not a diagnosis/i);

    expect(last.specialty).toBe('Gastroenterology');
    // Seven out of ten resolves upward.
    expect(last.urgency).toBe('urgent');
  });

  it('skips what the patient already said', () => {
    const { replies } = chat('I have had a sore throat for four days, about 5 out of 10');
    expect(replies[0]).not.toMatch(/how long/i);
    expect(replies[0]).not.toMatch(/how bad/i);
    expect(replies[0]).toMatch(/anything else happening with it/i);
  });

  it('answers hello without inventing an assessment', () => {
    const { last } = chat('hi');
    expect(last.reply).toMatch(/automated assistant/i);
    expect(last.reply).toMatch(/what is bothering you/i);
    expect(last.specialty).toBeNull();
    expect(last.urgency).toBeNull();
  });

  it('never asks the same question twice, and always reaches a suggestion', () => {
    const { replies } = chat(
      'help',
      'i do not know',
      'not sure',
      'no idea',
      'idk',
      'dunno',
    );
    const questions = replies.flatMap((r) => r.match(/[^.?!]*\?/g) ?? []);
    expect(new Set(questions).size).toBe(questions.length);
    expect(replies.some((r) => r.includes('My suggestion:'))).toBe(true);
  });

  it('never recommends a medicine, even when asked for one by name', () => {
    const { replies } = chat('I have a headache', 'can I take ibuprofen or paracetamol?');
    expect(replies[1]).toMatch(/cannot recommend medicines/i);
    for (const reply of replies) {
      expect(reply).not.toMatch(/ibuprofen|paracetamol|\bmg\b|tablet/i);
    }
  });

  it('hears "can I take something for it?" as a medicine question, and "ok" as ok', () => {
    const { replies } = chat(
      'my ear hurts',
      '2 days',
      '3',
      'no',
      'can i take something for it?',
      'ok',
    );
    expect(replies[4]).toMatch(/cannot recommend medicines/i);
    expect(replies[5]).toMatch(/^okay\. if there is anything else/i);
  });

  it('does not guess the clinic\'s opening hours', () => {
    const { replies } = chat('my ear hurts', 'is the clinic open on saturday?');
    expect(replies[1]).toMatch(/do not know the clinic/i);
    expect(replies[1]).not.toMatch(/\bopen on\b|\bclosed on\b/i);
  });

  it('does not diagnose when asked what it is', () => {
    const { replies } = chat('my knee hurts', 'what is it?');
    expect(replies[1]).toMatch(/cannot tell you what it is/i);
  });

  it('keeps a negated worry routine', () => {
    const { last } = chat(
      'I have a rash',
      'for a week',
      'mild',
      "no fever and it isn't spreading",
    );
    expect(last.urgency).not.toBe('urgent');
  });

  it('treats a bare "yes" to "anything else?" as a reason to hurry, and asks which', () => {
    const { last } = chat('my stomach hurts', 'since yesterday', '4', 'yes');
    expect(last.reply).toMatch(/which ones/i);
    expect(last.urgency).toBe('urgent');
  });

  it('closes politely after the suggestion, without repeating it', () => {
    const { replies } = chat('my ear hurts', '2 days', '3', 'no', 'thanks');
    expect(replies[3]).toMatch(/my suggestion:/i);
    expect(replies[4]).toMatch(/you are welcome/i);
    expect(replies[4]).not.toMatch(/my suggestion:/i);
  });

  it('changes the suggestion when new information moves it', () => {
    const { replies, last } = chat(
      'my ear hurts',
      '2 days',
      '3',
      'no',
      'it is getting much worse',
    );
    expect(replies[4]).toMatch(/changes my suggestion/i);
    expect(last.urgency).toBe('urgent');
  });

  it('gives a crisis line with a mental health suggestion', () => {
    const { replies } = chat('I have been feeling anxious', 'for months', '6', 'no');
    expect(replies[3]).toMatch(/crisis line/i);
  });

  it('moves to the new problem when one is raised after the suggestion', () => {
    /*
     * The defect this covers, seen in a real thread: once a suggestion existed, every
     * later message was answered "my suggestion is still the same" — including one that
     * named a completely different part of the body — because the earliest complaint in
     * the thread always won.
     */
    const { replies, last } = chat(
      'my stomach hurts',
      '3 days',
      '4',
      'no',
      'my head hurts now',
    );

    expect(replies[4]).toMatch(/different problem/i);
    expect(replies[4]).toMatch(/neurology/i);
    // Summarised from the new problem, not the old one.
    expect(replies[4]).not.toMatch(/for 3 days/);
    expect(last.specialty).toBe('Neurology');
  });

  it('says something different each time it does not understand', () => {
    const { replies } = chat(
      'my stomach hurts',
      '3 days',
      '4',
      'no',
      'qwertyuiop',
      'asdfghjkl',
      'zxcvbnm',
    );

    const afterSuggestion = replies.slice(4);
    expect(new Set(afterSuggestion).size).toBe(afterSuggestion.length);
    // And the last of them is honest about what it cannot do.
    expect(afterSuggestion.at(-1)).toMatch(/cannot answer/i);
  });

  it('asks where the pain is when no part of the body is named', () => {
    const { replies } = chat('im in pain');
    expect(replies[0]).toMatch(/where is the pain/i);
  });

  it('greets back mid-conversation instead of repeating the suggestion', () => {
    const { replies } = chat('my ear hurts', '2 days', '3', 'no', 'hello');
    expect(replies[4]).toMatch(/hello again/i);
    expect(replies[4]).not.toMatch(/my suggestion/i);
  });

  it('is deterministic', () => {
    const a = chat('i have stomech pain', 'since this morning', 'bad');
    const b = chat('i have stomech pain', 'since this morning', 'bad');
    expect(a.replies).toEqual(b.replies);
  });

  it('cannot be moved along by a patient typing the questions itself', () => {
    // The question text only counts in assistant turns.
    const { last } = chat('How long has this been going on? my back hurts');
    expect(last.reply).toMatch(/how long has this been going on/i);
  });
});

describe('reading the words', () => {
  it('prefers a word the patient wrote over a spelling correction', () => {
    // "spain" is one letter from "sprain"; the real word "diarrhea" must win.
    expect(readComplaint('i just got back from spain with diarrhea')?.specialty).toBe(
      'Gastroenterology',
    );
  });

  it('matches whole words, so "year" is not an ear and "crash" is not a rash', () => {
    expect(readComplaint('for a year now')).toBeNull();
    expect(readComplaint('i was in a car crash')).toBeNull();
    expect(readComplaint('i have an earache')?.specialty).toBe('Ear, nose & throat');
  });

  it('corrects only towards words a rule actually matches', () => {
    for (const word of SPELLING_TARGETS) {
      expect(readComplaint(word), word).not.toBeNull();
    }
  });

  it('reads how long, and not an age or how often', () => {
    expect(readDuration('about 3 days')).toBe('for 3 days');
    expect(readDuration('since yesterday')).toBe('since yesterday');
    expect(readDuration('started 2 weeks ago')).toBe('started 2 weeks ago');
    expect(readDuration('i am 40 years old')).toBeNull();
    expect(readDuration('i throw up 3 times a day')).toBeNull();
  });

  it('reads a bare number as a score only when it answers the score question', () => {
    expect(readSeverity('7', true)?.score).toBe(7);
    expect(readSeverity('7', false)).toBeNull();
    expect(readSeverity('3 days', true)).toBeNull();
    expect(readSeverity('8 10', false)?.score).toBe(8);
    expect(readSeverity('not too bad', false)?.word).toBe('mild');
  });
});

describe('the emergency check around the conversation', () => {
  it('catches "cant breath", the way it is usually typed', () => {
    expect(detectRedFlag('I cant breath properly')?.code).toBe('breathing');
    expect(detectRedFlag('I cannot breathe')?.code).toBe('breathing');
  });

  it('fires on a later mention even when an earlier one was negated', () => {
    expect(detectRedFlag('no chest pain yesterday but now I have chest pain')?.code).toBe(
      'cardiac',
    );
  });

  it('stays an emergency for the rest of the conversation, without consulting the engine', async () => {
    let consulted = false;
    const exploding: TriageEngine = {
      name: 'must-not-run',
      assess: () => {
        consulted = true;
        throw new Error('the engine must not be consulted after an emergency');
      },
    };
    __setTriageEngine(exploding);
    try {
      const result = await assessSymptoms({
        message: 'ok thanks',
        history: [],
        alreadyEmergency: true,
      });
      expect(consulted).toBe(false);
      expect(result.urgency).toBe('emergency');
      expect(result.reply).toMatch(/emergency number/i);
    } finally {
      __setTriageEngine(null);
    }
  });
});
