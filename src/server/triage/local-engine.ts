import 'server-only';

import {
  GENERAL,
  RULES,
  prepare,
  readComplaint,
  readDuration,
  readIntents,
  readSeverity,
  readUrgency,
  type Intents,
  type Rule,
  type Severity,
} from './local-understanding';
import type { TriageEngine, TriageRequest, TriageResult, TriageUrgency } from './types';

/**
 * The default engine: in-process, deterministic, no network.
 *
 * This is not a placeholder for the "real" one. It is the engine a clinic runs when it has
 * not signed a BAA with a model vendor, which is most clinics on most days, so the feature
 * has to be genuinely useful in that configuration rather than a disabled banner.
 *
 * It holds a short conversation, the way a receptionist would on the phone: what is wrong,
 * how long, how bad, anything else. Then it suggests a service and how soon. It answers
 * the questions patients actually ask along the way (can I take something, what is it,
 * can I book, am I talking to a person) without ever diagnosing or naming a medicine.
 *
 * STATELESS BY DESIGN. Nothing is remembered between messages except the conversation
 * itself. Every turn re-reads the whole thread, pairing each patient message with the
 * question it answered, so the state a reviewer would want to check is exactly the text
 * they can see. Two identical threads always get the same next message.
 *
 * The emergency check has already run on this message before this file is reached, and
 * nothing here can overturn it (see index.ts).
 */

/* ----------------------------------------------------------------------- questions */

/*
 * What the assistant asks, word for word. The exact sentences are how a later turn knows
 * what has been asked. They are only ever compared with assistant turns, which this file
 * wrote, so a patient typing the same words cannot move the conversation along.
 */
const Q = {
  open: 'What is bothering you today? Tell me in your own words, for example where the problem is and how long you have had it.',
  complaint:
    'Can you tell me a bit more? Where is the problem, and what does it feel like?',
  duration: 'How long has this been going on?',
  severity: 'How bad is it right now, from 1 (mild) to 10 (the worst you can imagine)?',
  which: 'Which ones? Tell me in your own words.',
} as const;

type QuestionId = keyof typeof Q | 'details';

/** The "anything else?" question, worded for the service the problem belongs to. */
function detailsQuestion(rule: Rule): string {
  return `Is anything else happening with it, like ${rule.examples}? Tell me in your own words, or say no.`;
}

/** Every wording of the details question, so it counts as asked even if the service changed. */
const DETAILS_QUESTIONS = [...RULES, GENERAL].map(detailsQuestion);

/** Starts every suggestion, and is how a later turn knows one has been given. */
const SUGGESTION = 'My suggestion:';

function questionIn(assistantTurn: string): QuestionId | null {
  if (DETAILS_QUESTIONS.some((q) => assistantTurn.includes(q))) return 'details';
  const found = (Object.keys(Q) as (keyof typeof Q)[]).find((id) =>
    assistantTurn.includes(Q[id]),
  );
  return found ?? null;
}

/* ------------------------------------------------------------------------- replies */

const URGENCY_SENTENCE: Record<TriageUrgency, string> = {
  emergency: '',
  urgent: 'Try to be seen in the next day or two.',
  routine: 'A routine appointment is fine.',
  self_care: 'This often settles on its own, but book if it lasts or gets worse.',
};

const ANSWERS = {
  greeting: 'Hello! I am the clinic’s automated assistant.',
  identity:
    'I am the clinic’s automated assistant, not a person. I ask a few questions and suggest which of our services to book. I cannot diagnose anything.',
  human:
    'Nobody reads this chat as it happens. To talk to someone, call the clinic, or book an appointment and a clinician will see you.',
  medicine:
    'I cannot recommend medicines or doses. A pharmacist can advise on what is safe to take, and a clinician can at your appointment.',
  diagnosis:
    'I cannot tell you what it is. Only a clinician can, after seeing you. What I can do is point you to the right service.',
  booking: 'You can book at any time with the link below this chat.',
  closing:
    'You are welcome. I hope you feel better soon. If it gets worse before your appointment, book an earlier one or call the clinic. If it ever feels like an emergency, call your local emergency number.',
  anythingElse: 'Is there anything else you want to tell me?',
  crisis:
    'If you ever feel you might harm yourself, contact your local crisis line or emergency number straight away.',
  disclaimer: 'This is not a diagnosis, and nobody has read this yet.',
} as const;

/* Varied a little so a run of answers does not read like a form, and chosen by position
   in the thread rather than at random so the same thread always gets the same words. */
const THANKS = ['Thanks.', 'Got it, thank you.', 'Okay, thank you.'] as const;

/* --------------------------------------------------------------- reading the thread */

type Answer = { prepared: string; question: QuestionId | null; intents: Intents };

type Understanding = {
  rule: Rule | null;
  duration: string | null;
  severity: Severity | null;
  urgentHint: boolean;
};

function understand(answers: Answer[]): Understanding {
  const text = answers.map((a) => a.prepared).join(' . ');
  const severity =
    readSeverity(text, false) ??
    answers
      .filter((a) => a.question === 'severity')
      .map((a) => readSeverity(a.prepared, true))
      .find((s) => s !== null) ??
    null;

  return {
    rule: readComplaint(text),
    duration: readDuration(text),
    severity,
    urgentHint: answers.some((a) => a.question === 'details' && a.intents.yes),
  };
}

function urgencyOf(answers: Answer[], u: Understanding): TriageUrgency {
  return readUrgency(
    answers.map((a) => a.prepared).join(' . '),
    u.severity,
    u.urgentHint,
  );
}

function summary(u: Understanding, rule: Rule): string {
  const parts: string[] = [rule.topic];
  if (u.duration) parts.push(u.duration);
  if (u.severity?.score) parts.push(`rated ${u.severity.score} out of 10`);
  else if (u.severity) parts.push(u.severity.word);
  return `Here is what I understood: ${parts.join(', ')}.`;
}

function suggestion(u: Understanding, rule: Rule, urgency: TriageUrgency): string {
  return [
    summary(u, rule),
    `${SUGGESTION} ${rule.because}`,
    URGENCY_SENTENCE[urgency],
    rule.specialty === 'Mental health' ? ANSWERS.crisis : '',
    'You can book with the link below this chat, and choose any visit type.',
    ANSWERS.disclaimer,
  ]
    .filter(Boolean)
    .join(' ');
}

/* ------------------------------------------------------------------------ the turn */

export function converse(request: TriageRequest): TriageResult {
  /* Pair every patient message with the question just before it. */
  const answers: Answer[] = [];
  const asked = new Set<QuestionId>();
  let lastQuestion: QuestionId | null = null;
  let suggested = false;

  for (const turn of request.history) {
    if (turn.role === 'assistant') {
      lastQuestion = questionIn(turn.body);
      if (lastQuestion) asked.add(lastQuestion);
      if (turn.body.includes(SUGGESTION)) suggested = true;
    } else {
      answers.push({
        prepared: prepare(turn.body),
        question: lastQuestion,
        intents: readIntents(turn.body),
      });
    }
  }
  const current: Answer = {
    prepared: prepare(request.message),
    question: lastQuestion,
    intents: readIntents(request.message),
  };

  const before = understand(answers);
  const now = understand([...answers, current]);
  const rule = now.rule ?? GENERAL;
  const urgency = urgencyOf([...answers, current], now);
  const intents = current.intents;

  const reply: string[] = [];

  /*
   * Nothing to assess yet: no problem named, nothing about how long or how bad, and the
   * "what is wrong?" question not yet asked. The conversation is then left unassessed
   * rather than filed under general practice, so the front desk queue shows "Not
   * assessed" instead of a suggestion nobody made.
   */
  const saidNothingYet = !now.rule && !now.duration && !now.severity;
  const nothingToAssess =
    saidNothingYet && urgency === 'routine' && !asked.has('complaint');

  /* A hello with nothing else in it: introduce, and ask the opening question. */
  if (intents.greeting && saidNothingYet && !asked.has('open')) {
    return {
      reply: `${ANSWERS.greeting} ${Q.open}`,
      specialty: null,
      urgency: nothingToAssess ? null : urgency,
      engine: ENGINE_NAME,
    };
  }

  /* Questions the patient asked get a straight answer before anything else. */
  if (intents.identity) reply.push(ANSWERS.identity);
  if (intents.human) reply.push(ANSWERS.human);
  if (intents.medicine) reply.push(ANSWERS.medicine);
  if (intents.diagnosis) reply.push(ANSWERS.diagnosis);
  if (intents.booking) reply.push(ANSWERS.booking);

  /* Acknowledge the problem once, the first time it is understood. */
  if (now.rule && !before.rule) reply.unshift(now.rule.ack);
  else if (reply.length === 0 && answers.length > 0 && !suggested) {
    reply.push(THANKS[answers.length % THANKS.length]!);
  }
  if (intents.greeting && answers.length === 0) reply.unshift('Hello!');

  /* Then the next question, or the suggestion, or the close. */
  const next = nextQuestion(now, asked, current, lastQuestion);
  if (next) {
    reply.push(next === 'details' ? detailsQuestion(rule) : Q[next]);
  } else if (!suggested) {
    reply.push(suggestion(now, rule, urgency));
  } else {
    const was = {
      specialty: (before.rule ?? GENERAL).specialty,
      urgency: urgencyOf(answers, before),
    };
    if (was.specialty !== rule.specialty || was.urgency !== urgency) {
      reply.push('Thanks, that changes my suggestion.', suggestion(now, rule, urgency));
    } else if (intents.thanks || intents.bye || intents.no) {
      reply.push(ANSWERS.closing);
    } else if (intents.yes && reply.length === 0) {
      reply.push('Go ahead, I am listening.');
    } else if (intents.ok && reply.length === 0) {
      reply.push('Okay. If there is anything else, just tell me.');
    } else if (reply.length === 0) {
      reply.push(
        `Thanks, I have noted that. My suggestion is still the same: ${rule.because}`,
        ANSWERS.anythingElse,
      );
    }
  }

  return {
    reply: reply.join(' '),
    specialty: nothingToAssess ? null : rule.specialty,
    urgency: nothingToAssess ? null : urgency,
    engine: ENGINE_NAME,
  };
}

/**
 * The next thing to ask, or null when there is enough to suggest a service.
 *
 * Each question is asked at most once. "Not sure" is an answer, so a patient who cannot
 * say how long is not asked again; the conversation always reaches a suggestion within a
 * handful of turns, however it goes.
 */
function nextQuestion(
  u: Understanding,
  asked: Set<QuestionId>,
  current: Answer,
  lastQuestion: QuestionId | null,
): QuestionId | null {
  if (!u.rule && !asked.has('complaint')) return 'complaint';
  if (!u.duration && !asked.has('duration')) return 'duration';
  if (!u.severity && !asked.has('severity')) return 'severity';
  if (!asked.has('details')) return 'details';
  // "Yes" to "anything else?" without saying what: ask once which.
  if (lastQuestion === 'details' && current.intents.yes && !asked.has('which'))
    return 'which';
  return null;
}

/**
 * Versioned, because the conversation records which engine answered it and a reviewer six
 * years from now must be able to tell which rules produced a stored suggestion. `local`
 * was the one-message keyword matcher; `local:2` is this conversation.
 */
const ENGINE_NAME = 'local:2';

export class LocalTriageEngine implements TriageEngine {
  readonly name = ENGINE_NAME;

  assess(request: TriageRequest): Promise<TriageResult> {
    return Promise.resolve(converse(request));
  }
}
