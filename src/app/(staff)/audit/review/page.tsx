import Link from 'next/link';
import { z } from 'zod';

import { Badge, EmptyState, Table, TableContainer, Td, Th, Tr } from '@/components/ui';
import { formatWallClockInZone, todayInZone, zonedWeekRange } from '@/lib/clinic-time';
import { can } from '@/lib/permissions';
import { guardPage } from '@/server/auth/authorize';
import {
  buildReviewDigest,
  listReviews,
  type FlaggedRead,
} from '@/server/data-access/compliance-review';

import { ReviewForm } from './ReviewForm';

/**
 * The periodic review of system activity — §164.308(a)(1)(ii)(D), security review F17.
 *
 * ==========================================================================
 * WHY THIS PAGE EXISTS WHEN /audit ALREADY DOES
 * ==========================================================================
 *
 * `/audit` answers "what happened". It is a query tool, and it assumes the reviewer
 * already knows what to search for. This page answers the different question the rule
 * actually asks — "is anything here worth a second look, and did anybody check?" — by
 * pulling out the handful of patterns that matter and giving the reviewer somewhere to
 * put their conclusion.
 *
 * ADMINISTRATOR ONLY, on `audit.read`, like the log itself. Filing the review needs
 * `audit.review` in addition, checked in the data layer.
 *
 * READING THIS PAGE IS AUDITED, and it names patients, so it is recorded like any other
 * clinical read — including when the reviewer is the administrator whose own reads are
 * among those listed.
 */
export const metadata = { title: 'Activity review · Cliniqo' };
export const dynamic = 'force-dynamic';

const params = z.object({
  /** How many weeks back the window ENDS. 0 = the week just gone. */
  back: z.coerce.number().int().min(0).max(104).optional().default(0),
});

function Flagged({
  title,
  why,
  rows,
  timeZone,
  tone,
}: {
  title: string;
  why: string;
  rows: FlaggedRead[];
  timeZone: string;
  tone: 'warning' | 'info' | 'neutral';
}) {
  return (
    <section style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline' }}>
        <h2 style={{ fontSize: 'var(--text-md)', margin: 0 }}>{title}</h2>
        <Badge tone={rows.length === 0 ? 'neutral' : tone}>{rows.length}</Badge>
      </div>
      <p
        style={{
          margin: 0,
          fontSize: 'var(--text-sm)',
          color: 'var(--text-secondary)',
        }}
      >
        {why}
      </p>

      {rows.length === 0 ? (
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>Nothing in this period.</p>
      ) : (
        <TableContainer label={title}>
          <Table caption={`${title} — ${rows.length} in this period`}>
            <thead>
              <Tr>
                <Th>When</Th>
                <Th>Who</Th>
                <Th>Whose record</Th>
                <Th>What</Th>
                <Th>Stated reason</Th>
              </Tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <Tr key={`${r.patientId}-${r.occurredAt.toISOString()}-${i}`}>
                  <Td>{formatWallClockInZone(r.occurredAt, timeZone)}</Td>
                  <Td>{r.actorName}</Td>
                  <Td>
                    <Link href={`/patients/${r.patientId}`}>{r.patientName}</Link>
                  </Td>
                  <Td>{r.action}</Td>
                  <Td>{r.purpose ?? '—'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableContainer>
      )}
    </section>
  );
}

export default async function ActivityReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await guardPage('audit.read');
  const sp = await searchParams;
  const { back } = params.parse({ back: sp['back'] });
  const timeZone = session.clinicTimeZone;

  /*
   * A real calendar week in the CLINIC's zone, not a rolling seven days ending now.
   *
   * A window anchored to the current instant drifts between renders, so two people
   * reviewing "this week" would attest to two different periods and neither record would
   * line up with the other — which defeats the point of recording the period at all.
   * Monday to Monday is also how a person actually thinks about the question.
   *
   * `back = 0` is the most recent COMPLETE week. Reviewing a week still in progress means
   * reviewing it again later, which is how a period gets reviewed twice and nobody can
   * tell which pass was the real one.
   */
  const anchor = new Date(`${todayInZone(timeZone)}T00:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() - 7 * (back + 1));
  const [periodStart, periodEnd] = zonedWeekRange(
    anchor.toISOString().slice(0, 10),
    timeZone,
  );

  const [digest, history] = await Promise.all([
    buildReviewDigest(periodStart, periodEnd),
    listReviews(12),
  ]);

  const mayReview = can(session.permissions, 'audit.review');
  const nothingFlagged =
    digest.sameSurname.length === 0 &&
    digest.breakGlass.length === 0 &&
    digest.adminClinicalReads.length === 0 &&
    digest.bulkReaders.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <div>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          <Link href="/audit">Back to the audit log</Link>
        </p>
        <h1 style={{ fontSize: 'var(--text-xl)', margin: 'var(--space-1) 0' }}>
          Activity review
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatWallClockInZone(periodStart, timeZone)} to{' '}
          {formatWallClockInZone(periodEnd, timeZone)} · {digest.counts['totalEvents']}{' '}
          events · {digest.counts['denied']} refused · {digest.counts['exports']} record
          exports
        </p>
        <p style={{ margin: 'var(--space-2) 0 0', fontSize: 'var(--text-sm)' }}>
          <Link href={`/audit/review?back=${back + 1}`}>← earlier week</Link>
          {back > 0 ? (
            <>
              {' · '}
              <Link href={`/audit/review?back=${back - 1}`}>later week →</Link>
            </>
          ) : null}
        </p>
      </div>

      {/*
        Said once, at the top, and deliberately. Every row below was an AUTHORIZED action
        by someone doing their job; the list is a prompt to look, not a list of suspects.
        A review tool that reads as an indictment is one staff learn to wave through.
      */}
      <p
        style={{
          margin: 0,
          padding: 'var(--space-3) var(--space-4)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg-sunken)',
          fontSize: 'var(--text-sm)',
        }}
      >
        Everything below was permitted and logged. These are the patterns worth a second
        look, not a list of wrongdoing — most will have an ordinary explanation, and
        recording that explanation is the point of the review.
      </p>

      {nothingFlagged ? (
        <EmptyState
          title="Nothing flagged this period"
          description="No emergency access, no same-surname reads, no administrator clinical reads, and nobody reading at unusual volume. Worth recording that you checked."
        />
      ) : null}

      <Flagged
        title="Same surname as the patient"
        why="A staff member opened a record belonging to someone who shares their surname — or their own. Every one of these was authorized, which is exactly why no permission check can catch it. Matching is by name only: it over-reports common surnames and misses married names."
        rows={digest.sameSurname}
        timeZone={timeZone}
        tone="warning"
      />

      <Flagged
        title="Emergency access taken"
        why="Break-glass is required by §164.312(a)(2)(ii) and is meant to be used when it is needed. It is logged loudly so that it is read afterwards — which is here."
        rows={digest.breakGlass}
        timeZone={timeZone}
        tone="warning"
      />

      <Flagged
        title="Clinical records opened by an administrator"
        why="An administrator is an operational role, not a clinical one. They hold clinical read access by design, and an office manager browsing charts is the pattern an audit looks for — so it is surfaced rather than assumed benign."
        rows={digest.adminClinicalReads}
        timeZone={timeZone}
        tone="info"
      />

      <section style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline' }}>
          <h2 style={{ fontSize: 'var(--text-md)', margin: 0 }}>Unusual read volume</h2>
          <Badge tone={digest.bulkReaders.length === 0 ? 'neutral' : 'info'}>
            {digest.bulkReaders.length}
          </Badge>
        </div>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          The throttle stops a fast scrape; this catches the slow one. Counts only — open
          the log filtered by the actor to see what they read.
        </p>
        {digest.bulkReaders.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>Nothing in this period.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
            {digest.bulkReaders.map((r) => (
              <li key={r.actorUserId} style={{ fontSize: 'var(--text-sm)' }}>
                <Link href={`/audit?actor=${r.actorUserId}`}>{r.actorName}</Link> —{' '}
                {r.reads} events
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}

      <section style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <h2 style={{ fontSize: 'var(--text-md)', margin: 0 }}>Record your review</h2>

        {digest.alreadyReviewed.length > 0 ? (
          <div
            role="status"
            style={{
              display: 'grid',
              gap: 'var(--space-1)',
              padding: 'var(--space-3) var(--space-4)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--status-ok-bg, var(--bg-sunken))',
              fontSize: 'var(--text-sm)',
            }}
          >
            {digest.alreadyReviewed.map((r) => (
              <span key={r.reviewedAt.toISOString()}>
                <strong>
                  Reviewed {formatWallClockInZone(r.reviewedAt, timeZone)} by{' '}
                  {r.reviewerName}.
                </strong>{' '}
                {r.notes}
              </span>
            ))}
          </div>
        ) : null}

        {mayReview ? (
          <ReviewForm
            periodStart={periodStart.toISOString()}
            periodEnd={periodEnd.toISOString()}
            alreadyReviewed={digest.alreadyReviewed.length > 0}
          />
        ) : (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
            You can read this review but not file one.
          </p>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}

      <section style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <h2 style={{ fontSize: 'var(--text-md)', margin: 0 }}>Review history</h2>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          Carries no patient identifiers, so this is the part that can be handed to an
          auditor as it is.
        </p>
        {history.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
            No reviews recorded yet.
          </p>
        ) : (
          <TableContainer label="Review history">
            <Table caption="Recorded reviews of system activity, most recent period first">
              <thead>
                <Tr>
                  <Th>Period</Th>
                  <Th>Reviewed</Th>
                  <Th>By</Th>
                  <Th>Flagged</Th>
                  <Th>Conclusion</Th>
                </Tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <Tr key={r.id}>
                    <Td>
                      {formatWallClockInZone(r.periodStart, timeZone)} –{' '}
                      {formatWallClockInZone(r.periodEnd, timeZone)}
                    </Td>
                    <Td>{formatWallClockInZone(r.reviewedAt, timeZone)}</Td>
                    <Td>{r.reviewerName}</Td>
                    <Td>
                      {Object.entries(r.findings)
                        .filter(([k, v]) => v > 0 && k !== 'totalEvents')
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(', ') || 'none'}
                    </Td>
                    <Td>{r.notes}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableContainer>
        )}
      </section>
    </div>
  );
}
