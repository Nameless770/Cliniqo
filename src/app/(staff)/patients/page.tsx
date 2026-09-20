import Link from 'next/link';

import { can } from '@/lib/permissions';
import { guardPage } from '@/server/auth/authorize';
import { searchPatients } from '@/server/data-access/patients';

import { PatientSearch } from './PatientSearch';

/**
 * Patient list — the shell around the search.
 *
 * A Server Component still: it holds the authorization gate and performs the FIRST search,
 * so the roster is on screen in the initial response rather than after a round trip. The
 * interactive part below it re-searches through a server action, which re-checks
 * authorization itself rather than trusting that this page already did.
 *
 * NOTHING ABOUT THE SEARCH IS IN THE URL ANY MORE. It used to carry `?q=`, justified as a
 * staff-typed query rather than a patient identifier. That reasoning holds for "diabetic
 * clinic" and breaks for "Mohammed Hassan", which is what the box is used for: a name in a
 * query string is a name in browser history, in the `Referer` of every outbound link from
 * this page, and in any proxy log on the way. It is a POST body now. `page` went with it
 * rather than staying behind — a page number is not PHI, but leaving a lone parameter
 * would mean half a search in the URL and half in a form, and the next person to touch
 * this would reasonably put the query back beside it.
 *
 * The cost of that is losing a linkable search result, which was worth less than it looks:
 * the link only worked for someone holding `patient.read.identifying`, and it was a link
 * that named a patient.
 */
export const metadata = { title: 'Patients · Cliniqo' };
export const dynamic = 'force-dynamic';

export default async function PatientsPage() {
  const session = await guardPage('patient.read.identifying');

  /* The opening roster: everyone, page one. Same audited path the action uses. */
  const list = await searchPatients({
    query: '',
    page: 1,
    pageSize: 25,
    includeArchived: false,
  });

  const mayCreate = can(session.permissions, 'patient.create');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 'var(--space-4)',
          flexWrap: 'wrap',
        }}
      >
        <h1 style={{ fontSize: 'var(--text-xl)', margin: 0 }}>Patients</h1>

        {mayCreate ? (
          <Link
            href="/patients/new"
            style={{
              padding: 'var(--space-2) var(--space-4)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--brand-solid)',
              color: 'var(--brand-text-on-solid)',
              textDecoration: 'none',
              fontSize: 'var(--text-sm)',
              fontWeight: 'var(--weight-medium)',
            }}
          >
            Register patient
          </Link>
        ) : null}
      </div>

      <PatientSearch
        initial={{
          rows: list.rows,
          total: list.total,
          query: '',
          includeArchived: false,
          page: list.page,
          pageCount: list.pageCount,
        }}
        /* Archived records are a deliberate lookup, not a default view. */
        canSeeArchived={can(session.permissions, 'patient.read.identifying')}
      />
    </div>
  );
}
