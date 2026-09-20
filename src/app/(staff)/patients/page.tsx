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

<<<<<<< HEAD
      {/* GET, so the search is a normal navigation: linkable, bookmarkable, cacheable. */}
      <form
        method="get"
        style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}
      >
        <label htmlFor="patient-search" className="sr-only">
          Search patients by name, MRN, or phone number
        </label>
        <input
          id="patient-search"
          name="q"
          type="search"
          defaultValue={input.query}
          placeholder="Name, MRN, or phone"
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
            defaultChecked={input.includeArchived}
          />
          Include archived
        </label>

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
      </form>

      {list.rows.length === 0 ? (
        <EmptyState
          title={
            input.query ? 'No patients match that search' : 'No patients registered yet'
          }
          description={
            input.query
              ? 'Check the spelling, or try a partial surname — the search tolerates typos.'
              : 'Register the first patient to get started.'
          }
        />
      ) : (
        <>
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
                {list.rows.map((row) => (
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
                    <Td variant="numeric">{formatDob(row.dateOfBirth)}</Td>
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

          {list.pageCount > 1 ? (
            <nav
              aria-label="Pagination"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                fontSize: 'var(--text-sm)',
              }}
            >
              {list.page > 1 ? (
                <Link href={pageHref(list.page - 1)} rel="prev">
                  Previous
                </Link>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>Previous</span>
              )}

              <span aria-current="page">
                Page {list.page} of {list.pageCount}
              </span>

              {list.page < list.pageCount ? (
                <Link href={pageHref(list.page + 1)} rel="next">
                  Next
                </Link>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>Next</span>
              )}
            </nav>
          ) : null}
        </>
      )}
=======
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
>>>>>>> 3c852be467e981a80984d439073d542361c5a397
    </div>
  );
}
