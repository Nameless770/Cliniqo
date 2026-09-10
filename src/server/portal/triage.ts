import 'server-only';

import { and, asc, desc, eq, isNull } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { triageConversation, triageMessage } from '@/db/schema';
import { assessSymptoms, type TriageTurn, type TriageUrgency } from '@/server/triage';

import { auditAsPatient } from './data';
import { requirePatientSession } from './session';

/**
 * Symptom triage, patient side.
 *
 * The authority model is the portal's usual one and it is one line: every query filters on
 * `session.patientId`, and no function here takes a patient id a caller could point
 * somewhere else. A conversation id IS accepted, and is verified against the session's
 * patient inside the query rather than trusted.
 *
 * Symptom text is PHI, so every read and write here writes an audit row with the patient
 * as actor — including the reads, because §164.312(b) is about who looked.
 */

const MAX_MESSAGE_CHARS = 2000;
/** Enough for context, short enough that a third-party prompt stays small. */
const HISTORY_TURNS = 10;

export type TriageMessageView = {
  id: string;
  role: 'patient' | 'assistant';
  body: string;
  createdAt: Date;
};

export type TriageConversationView = {
  id: string;
  status: 'open' | 'closed';
  urgency: TriageUrgency | null;
  recommendedSpecialty: string | null;
  createdAt: Date;
  messages: TriageMessageView[];
};

/**
 * The patient's most recent conversation, with its turns. Null when they have never used
 * it — the page then renders the opening prompt rather than an empty thread.
 */
export async function getMyLatestTriage(): Promise<TriageConversationView | null> {
  const session = await requirePatientSession();
  const db = getDb();

  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .select({
        id: triageConversation.id,
        status: triageConversation.status,
        urgency: triageConversation.urgency,
        recommendedSpecialty: triageConversation.recommendedSpecialty,
        createdAt: triageConversation.createdAt,
      })
      .from(triageConversation)
      .where(
        and(
          eq(triageConversation.patientId, session.patientId),
          eq(triageConversation.clinicId, session.clinicId),
          isNull(triageConversation.archivedAt),
        ),
      )
      .orderBy(desc(triageConversation.createdAt))
      .limit(1);

    if (!conversation) {
      await auditAsPatient(tx, session, {
        action: 'triage.read',
        outcome: 'allowed',
        subjectPatientId: session.patientId,
        entityType: 'triage_conversation',
        metadata: { via: 'portal', found: false },
      });
      return null;
    }

    const messages = await tx
      .select({
        id: triageMessage.id,
        role: triageMessage.role,
        body: triageMessage.body,
        createdAt: triageMessage.createdAt,
      })
      .from(triageMessage)
      .where(eq(triageMessage.conversationId, conversation.id))
      .orderBy(asc(triageMessage.createdAt));

    await auditAsPatient(tx, session, {
      action: 'triage.read',
      outcome: 'allowed',
      subjectPatientId: session.patientId,
      entityType: 'triage_conversation',
      entityId: conversation.id,
      metadata: { via: 'portal', messageCount: messages.length },
    });

    return { ...conversation, messages };
  });
}

export type SendTriageResult =
  | {
      ok: true;
      conversationId: string;
      reply: string;
      urgency: TriageUrgency;
      specialty: string;
      /** Set when the emergency path fired — the UI renders it as an alert, not a chat turn. */
      redFlagCode: string | null;
    }
  | { ok: false; reason: 'empty' | 'too_long' | 'not_found' | 'closed' | 'upstream' };

/**
 * The patient sends one message and gets one answer.
 *
 * THE WRITE IS SPLIT ACROSS TWO TRANSACTIONS, DELIBERATELY.
 *
 * Assessment can call a third-party model over the network with a twelve-second timeout.
 * Holding a PostgreSQL transaction open across an external HTTP call pins a pooled
 * connection for its whole duration, and a dozen patients typing at once would exhaust the
 * pool and take down booking, the schedule and the charts along with it. So:
 *
 *   1. Transaction one records what the patient said and returns.
 *   2. Assessment runs with no transaction held.
 *   3. Transaction two records the answer.
 *
 * The ordering also decides what survives a failure. The patient's own words are committed
 * before anything can go wrong, so a model outage costs them a reply and not their
 * message — they retry against a thread that still has their history in it.
 */
export async function sendTriageMessage(
  conversationId: string | null,
  rawMessage: string,
): Promise<SendTriageResult> {
  const session = await requirePatientSession();
  const db = getDb();

  const message = rawMessage.trim();
  if (!message) return { ok: false, reason: 'empty' };
  if (message.length > MAX_MESSAGE_CHARS) return { ok: false, reason: 'too_long' };

  /* ---------------------------------------------- 1. the patient's turn, committed */
  const opened = await db.transaction(
    async (
      tx,
    ): Promise<
      { ok: true; id: string; history: TriageTurn[] } | { ok: false; reason: 'not_found' | 'closed' }
    > => {
      let id = conversationId;

      if (id) {
        const [existing] = await tx
          .select({ id: triageConversation.id, status: triageConversation.status })
          .from(triageConversation)
          .where(
            and(
              eq(triageConversation.id, id),
              // The authority check: it must be THIS patient's conversation.
              eq(triageConversation.patientId, session.patientId),
              eq(triageConversation.clinicId, session.clinicId),
              isNull(triageConversation.archivedAt),
            ),
          )
          .limit(1);

        if (!existing) return { ok: false, reason: 'not_found' };
        if (existing.status === 'closed') return { ok: false, reason: 'closed' };
      } else {
        const [created] = await tx
          .insert(triageConversation)
          .values({
            clinicId: session.clinicId,
            patientId: session.patientId,
            // Overwritten in transaction two; never left as a lie if that never runs.
            engine: 'pending',
          })
          .returning({ id: triageConversation.id });
        id = created!.id;

        await auditAsPatient(tx, session, {
          action: 'triage.start',
          outcome: 'allowed',
          subjectPatientId: session.patientId,
          entityType: 'triage_conversation',
          entityId: id,
          metadata: { via: 'portal' },
        });
      }

      const history = await tx
        .select({ role: triageMessage.role, body: triageMessage.body })
        .from(triageMessage)
        .where(eq(triageMessage.conversationId, id))
        .orderBy(desc(triageMessage.createdAt))
        .limit(HISTORY_TURNS);

      await tx.insert(triageMessage).values({
        conversationId: id,
        role: 'patient',
        body: message,
      });

      await auditAsPatient(tx, session, {
        action: 'triage.message',
        outcome: 'allowed',
        subjectPatientId: session.patientId,
        entityType: 'triage_conversation',
        entityId: id,
        /* Length, never content. An audit log carrying symptom text is a second copy of
           the chart with six-year retention and weaker access controls. */
        metadata: { via: 'portal', role: 'patient', chars: message.length },
      });

      return { ok: true, id, history: history.reverse() };
    },
  );

  if (!opened.ok) return { ok: false, reason: opened.reason };

  /* ------------------------------------------- 2. assessment, no transaction held */
  let assessment;
  try {
    assessment = await assessSymptoms({ message, history: opened.history });
  } catch {
    /* The upstream error is deliberately not surfaced or logged: its body can echo the
       request, which is the patient's symptom text. */
    return { ok: false, reason: 'upstream' };
  }

  /* ------------------------------------------------- 3. the answer, committed */
  await db.transaction(async (tx) => {
    await tx.insert(triageMessage).values({
      conversationId: opened.id,
      role: 'assistant',
      body: assessment.reply,
    });

    await tx
      .update(triageConversation)
      .set({
        urgency: assessment.urgency,
        recommendedSpecialty: assessment.specialty,
        engine: assessment.engine,
      })
      .where(eq(triageConversation.id, opened.id));

    await auditAsPatient(tx, session, {
      action: 'triage.message',
      outcome: 'allowed',
      subjectPatientId: session.patientId,
      entityType: 'triage_conversation',
      entityId: opened.id,
      metadata: {
        via: 'portal',
        role: 'assistant',
        engine: assessment.engine,
        urgency: assessment.urgency,
        specialty: assessment.specialty,
        redFlag: assessment.redFlagCode,
      },
    });
  });

  return {
    ok: true,
    conversationId: opened.id,
    reply: assessment.reply,
    urgency: assessment.urgency,
    specialty: assessment.specialty,
    redFlagCode: assessment.redFlagCode,
  };
}
