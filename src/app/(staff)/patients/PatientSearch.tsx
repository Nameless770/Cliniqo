'use client';

import Link from 'next/link';
import { useActionState, useEffect, useId, useRef, useState } from 'react';

import { Badge, EmptyState, Table, TableContainer, Td, Th, Tr } from '@/components/ui';
import { type PatientSearchState } from '@/lib/patient-search';
import { searchPatientsAction } from '@/server/actions/patient-search';

/**
 * Patient search that answers while you type.
 *
 * The screen the front desk spends its day on. It replaces a form that navigated the whole
 * page per search, which cost a round trip for every corrected spelling and put the
 * patient's name in the URL on the way.
 *
 * THE DEBOUNCE IS NOT THE MECHANISM. This is a real `<form action={…}>` bound to a server
 * action; the timer below only calls `requestSubmit()` earlier than a person would. That
 * keeps the interactive path and the plain-submit path identical, which is why there is a
 * `<noscript>` button at all.
 *
 * It is NOT, however, a working no-JavaScript configuration, and the comment here used to
 * claim otherwise. Sign-in does not complete with scripting disabled — the session cookie
 * is never set — so this page cannot be reached that way. Tested, not assumed. The
 * fallback button is kept because it costs nothing and becomes correct the day sign-in
 * gains a no-script path; it is not evidence that one exists.
 *
 * WHAT IT IS ALLOWED TO HOLD. `PatientListRow` is the same narrow projection the table
 * renders: name, MRN, date of birth, phone. No clinical fields reach this component,
 * because anything on these props is serialised into the document rather than merely
 * rendered from it.
 *
 * WHY IT IS NOT FASTER STILL. `patient.search` counts against the PHI read ceiling (120
 * reads per 10 minutes), so a request per keystroke would spend a clinician's budget on a
 * handful of names and lock them out mid-clinic. The debounce and the two-character floor
 * exist for that reason first and for server load second.
 *
 * Measured in a browser rather than reasoned about: typing the eight-character surname
 * "Hassanov" at 90ms per keystroke charges exactly ONE `patient.search` event. A burst of
 * typing collapses to a single search, so the budget cost of finding a patient is the same
 * as it was with a submit button — and lower for anyone who used to submit twice because
 * they misspelled it the first time.
 */

/** Long enough to collapse a typed name into one search, short enough to feel immediate. */
const DEBOUNCE_MS = 350;

/**
 * A single character matches most of the roster, which is a large PHI read for no
 * information. Two is the point where the result set means something.
 */
const MIN_QUERY = 2;

export function PatientSearch({
  initial,
  canSeeArchived,
}: {
  initial: PatientSearchState;
  canSeeArchived: boolean;
}) {
  const [state, action, pending] = useActionState<PatientSearchState, FormData>(
    searchPatientsAction,
    initial,
  );

  const formRef = useRef<HTMLFormElement>(null);
  const [query, setQuery] = useState(initial.query);
  const [archived, setArchived] = useState(initial.includeArchived);
  const [page, setPage] = useState(initial.page);
  const listId = useId();

  /**
   * The last query actually sent.
   *
   * Without it, every re-render that leaves the text unchanged — toggling focus, the
   * action resolving — would spend another search from the read budget for a result
   * already on screen.
   */
  const lastSent = useRef(initial.query);

  useEffect(() => {
    const trimmed = query.trim();

    /* Below the floor: clear rather than search, so the table does not keep stale names. */
    if (trimmed.length > 0 && trimmed.length < MIN_QUERY) return;
    if (trimmed === lastSent.current) return;

    const timer = setTimeout(() => {
      lastSent.current = trimmed;
      formRef.current?.requestSubmit();
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, archived]);

  /* Paging is a deliberate act, so it submits at once rather than after the debounce.
     `lastSent` is left alone: the query has not changed, only the offset into it. */
  const step = (delta: number) => {
    setPage((p) => Math.max(1, p + delta));
    queueMicrotask(() => formRef.current?.requestSubmit());
  };

  const rows = state.rows;
  const showing = state.query.trim().length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <form
        ref={formRef}
        action={action}
        style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}
      >
        <input type="hidden" name="page" value={page} />
        <label htmlFor="patient-search" className="sr-only">
          Search patients by name, MRN, or phone number
        </label>
        <input
          id="patient-search"
          name="q"
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            /* A new query has no page 3. Staying on it would show an empty table and
               read as "no such patient". */
            setPage(1);
          }}
          placeholder="Name, MRN, or phone"
          autoComplete="off"
          aria-controls={listId}
          style={{
            flex: '1 1 18rem',
            minHeight: '2.25rem',
            padding: 'var(--space-2) var(--space-3)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-surface)',
            color: 'var(--text-primary)',
            fontSize: 'var(--text-base)',
          }}
        />

        {canSeeArchived ? (
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              fontSize: 'var(--text-sm)',
              color: 'var(--text-secondary)',
            }}
          >
            <input
              type="checkbox"
              name="archived"
              value="1"
              checked={archived}
              onChange={(e) => {
                setArchived(e.target.checked);
                /* A toggle is a deliberate act, so it searches without waiting. */
                lastSent.current = '\u0000';
              }}
            />
            Include archived
          </label>
        ) : null}

        {/*
          The no-JavaScript path. Hidden once the component has mounted, because by then
          the debounce is driving submission and a second control would only ever spend a
          redundant search from the read budget.
        */}
        <noscript>
          <button
            type="submit"
            style={{
              minHeight: '2.25rem',
              padding: '0 var(--space-4)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-default)',
              background: 'var(--bg-surface)',
              color: 'var(--text-primary)',
              fontSize: 'var(--text-base)',
              cursor: 'pointer',
            }}
          >
            Search
          </button>
        </noscript>
      </form>

      {/*
        One live region for the whole result state. `polite` rather than `assertive`: a
        screen-reader user typing a name should hear the count when they pause, not be
        interrupted on every keystroke.
      */}
      <p
        aria-live="polite"
        style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}
      >
        {state.message
          ? state.message
          : pending
            ? 'Searching…'
            : `${state.total} ${state.total === 1 ? 'record' : 'records'}${
                showing ? ` matching “${state.query}”` : ''
              }${state.includeArchived ? ', including archived' : ''}`}
      </p>

      <div id={listId}>
        {rows.length === 0 ? (
          <EmptyState
            title={
              showing ? 'No patients match that search' : 'No patients registered yet'
            }
            description={
              showing
                ? 'Check the spelling, or try a partial surname — the search tolerates typos.'
                : 'Register the first patient to get started.'
            }
          />
        ) : (
          <TableContainer label="Patient list">
            <Table caption="Patients" captionVisible={false}>
              <thead>
                <Tr>
                  <Th>MRN</Th>
                  <Th>Name</Th>
                  <Th>Date of birth</Th>
                  <Th>Phone</Th>
                  <Th>Status</Th>
                </Tr>
              </thead>
              {/* The first rows arrive one after another; the rest are simply there. */}
              <tbody className="cq-stagger">
                {rows.map((row) => (
                  <Tr key={row.id}>
                    <Td variant="identifier">{row.mrn}</Td>
                    <Td>
                      <Link href={`/patients/${row.id}`}>
                        {row.legalLastName}, {row.legalFirstName}
                      </Link>
                      {row.preferredName ? (
                        <span style={{ color: 'var(--text-muted)' }}>
                          {' '}
                          ({row.preferredName})
                        </span>
                      ) : null}
                    </Td>
                    <Td variant="numeric">{row.dateOfBirth}</Td>
                    <Td variant="numeric">{row.phonePrimary ?? '—'}</Td>
                    <Td>
                      {row.archivedAt ? (
                        <Badge tone="neutral">Archived</Badge>
                      ) : (
                        <Badge tone="success">Active</Badge>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableContainer>
        )}
      </div>

      {state.pageCount > 1 ? (
        <nav
          aria-label="Pagination"
          style={{
            display: 'flex',
            gap: 'var(--space-2)',
            alignItems: 'center',
            fontSize: 'var(--text-sm)',
          }}
        >
          <button
            type="button"
            disabled={state.page <= 1 || pending}
            onClick={() => step(-1)}
            style={pagerStyle(state.page <= 1 || pending)}
          >
            Previous
          </button>
          <span style={{ color: 'var(--text-secondary)' }}>
            Page {state.page} of {state.pageCount}
          </span>
          <button
            type="button"
            disabled={state.page >= state.pageCount || pending}
            onClick={() => step(1)}
            style={pagerStyle(state.page >= state.pageCount || pending)}
          >
            Next
          </button>
        </nav>
      ) : null}
    </div>
  );
}

function pagerStyle(disabled: boolean): React.CSSProperties {
  return {
    minHeight: '2rem',
    padding: '0 var(--space-3)',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border-default)',
    background: 'var(--bg-surface)',
    color: disabled ? 'var(--text-secondary)' : 'var(--text-primary)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };
}
