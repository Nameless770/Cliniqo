import Link from 'next/link';

import { Badge, EmptyState, Table, TableContainer, Td, Th, Tr } from '@/components/ui';
import { can } from '@/lib/permissions';
import { patientSearchInput } from '@/lib/patient-schemas';
import { guardPage } from '@/server/auth/authorize';
import { searchPatients } from '@/server/data-access/patients';

/**
 * Patient list — search and pagination.
 *
 * A Server Component. The rows never cross into a Client Component, so patient names are
 * rendered on the server and are not serialised into a client payload.
 *
 * Search state lives in the URL as `?q=` and `?page=`, which makes results linkable and
 * back-button-correct. Note what is NOT in the URL: no patient id, no date of birth, no
 * name — those would end up in browser history, proxy logs, and Referer headers.
 * A search term is a staff-typed query, not a patient identifier.
 */
export const metadata = { title: 'Patients · Cliniqo' };
export const dynamic = 'force-dynamic';

function formatDob(iso: string): string {
  return iso;
}

export default async function PatientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await guardPage('patient.read.identifying');
  const params = await searchParams;

  const parsed = patientSearchInput.safeParse({
    query: typeof params['q'] === 'string' ? params['q'] : '',
    page: typeof params['page'] === 'string' ? params['page'] : 1,
    includeArchived: params['archived'] === '1',
  });

  // A malformed query string is a bad request, not a crash: fall back to defaults.
  const input = parsed.success
    ? parsed.data
    : { query: '', page: 1, pageSize: 25, includeArchived: false };

  const list = await searchPatients(input);
  const mayCreate = can(session.permissions, 'patient.create');

  const pageHref = (page: number) => {
    const sp = new URLSearchParams();
    if (input.query) sp.set('q', input.query);
    if (input.includeArchived) sp.set('archived', '1');
    if (page > 1) sp.set('page', String(page));
    const qs = sp.toString();
    return qs ? `/patients?${qs}` : '/patients';
  };

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
        <div>
          <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-1)' }}>
            Patients
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: 'var(--text-sm)',
              color: 'var(--text-secondary)',
            }}
          >
            {list.total} {list.total === 1 ? 'record' : 'records'}
            {input.includeArchived ? ' (including archived)' : ''}
          </p>
        </div>

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
              <tbody>
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
    </div>
  );
}
