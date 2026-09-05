import Link from 'next/link';
import { z } from 'zod';

import { Badge, EmptyState, Table, TableContainer, Td, Th, Tr } from '@/components/ui';
import { guardPage } from '@/server/auth/authorize';
import { getAuditFilterOptions, readAuditLog } from '@/server/data-access/admin';

/**
 * Audit log viewer. Administrator only.
 *
 * READING THIS PAGE IS ITSELF AUDITED — `readAuditLog` goes through the audited layer and
 * writes one `audit.read` row per query, recording who looked and WHICH FILTERS they
 * used. Filter values are not recorded: a filter naming a patient would write that
 * patient's identity into the log a second time.
 *
 * Filters live in the URL so a review is linkable and reproducible. Note what the URL
 * carries — opaque ids and an action name, never a patient name.
 */
export const metadata = { title: 'Audit log · Cliniqo' };
export const dynamic = 'force-dynamic';

const filterInput = z.object({
  actor: z.uuid().optional(),
  patient: z.uuid().optional(),
  action: z.string().max(60).optional(),
  outcome: z.enum(['allowed', 'denied', 'error']).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
});

function tone(outcome: string) {
  if (outcome === 'denied') return 'warning' as const;
  if (outcome === 'error') return 'danger' as const;
  return 'success' as const;
}

const control = {
  minHeight: '2.25rem',
  padding: 'var(--space-1) var(--space-2)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  fontSize: 'var(--text-sm)',
} as const;

const label = { display: 'grid', gap: '2px', fontSize: 'var(--text-xs)' } as const;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await guardPage('audit.read');
  const sp = await searchParams;

  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);

  const parsed = filterInput.safeParse({
    actor: one('actor') || undefined,
    patient: one('patient') || undefined,
    action: one('action') || undefined,
    outcome: one('outcome') || undefined,
    from: one('from') || undefined,
    to: one('to') || undefined,
    page: one('page') ?? 1,
  });

  const f = parsed.success ? parsed.data : { page: 1 };

  const [options, result] = await Promise.all([
    getAuditFilterOptions(),
    readAuditLog({
      ...(f.actor ? { actorUserId: f.actor } : {}),
      ...(f.patient ? { subjectPatientId: f.patient } : {}),
      ...(f.action ? { action: f.action } : {}),
      ...(f.outcome ? { outcome: f.outcome } : {}),
      ...(f.from ? { from: new Date(`${f.from}T00:00:00Z`) } : {}),
      // Inclusive end of day, so "to = today" includes today.
      ...(f.to ? { to: new Date(`${f.to}T23:59:59.999Z`) } : {}),
      page: f.page,
      pageSize: 50,
    }),
  ]);

  const pageHref = (page: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) {
      if (v !== undefined && k !== 'page') q.set(k, String(v));
    }
    if (page > 1) q.set('page', String(page));
    return `/audit?${q.toString()}`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-1)' }}>
          Audit log
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          {result.total} events. Append-only, retained six years. Your review of this page
          is itself recorded.
        </p>
      </div>

      <form
        method="get"
        style={{
          display: 'flex',
          gap: 'var(--space-2)',
          flexWrap: 'wrap',
          alignItems: 'end',
        }}
      >
        <label style={label}>
          Staff member
          <select name="actor" defaultValue={f.actor ?? ''} style={control}>
            <option value="">Anyone</option>
            {options.actors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>

        <label style={label}>
          Action
          <select name="action" defaultValue={f.action ?? ''} style={control}>
            <option value="">Any action</option>
            {options.actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>

        <label style={label}>
          Outcome
          <select name="outcome" defaultValue={f.outcome ?? ''} style={control}>
            <option value="">Any</option>
            <option value="allowed">Allowed</option>
            <option value="denied">Denied</option>
            <option value="error">Error</option>
          </select>
        </label>

        <label style={label}>
          Patient ID
          <input
            name="patient"
            defaultValue={f.patient ?? ''}
            placeholder="uuid"
            style={control}
          />
        </label>

        <label style={label}>
          From
          <input name="from" type="date" defaultValue={f.from ?? ''} style={control} />
        </label>

        <label style={label}>
          To
          <input name="to" type="date" defaultValue={f.to ?? ''} style={control} />
        </label>

        <button type="submit" style={{ ...control, cursor: 'pointer' }}>
          Filter
        </button>
        <Link href="/audit" style={{ fontSize: 'var(--text-sm)' }}>
          Clear
        </Link>
      </form>

      {result.rows.length === 0 ? (
        <EmptyState
          title="No events match those filters"
          description="Widen the date range, or clear the filters."
        />
      ) : (
        <>
          <TableContainer label="Audit events">
            <Table caption="Audit events" captionVisible={false}>
              <thead>
                <Tr>
                  <Th>When (UTC)</Th>
                  <Th>Actor</Th>
                  <Th>Action</Th>
                  <Th>Outcome</Th>
                  <Th>Patient</Th>
                  <Th>Entity</Th>
                </Tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <Tr key={r.id}>
                    <Td variant="numeric">
                      {r.occurredAt.toISOString().replace('T', ' ').slice(0, 19)}
                    </Td>
                    <Td>
                      {r.actorName ?? '—'}
                      {r.actorRoleCodes?.length ? (
                        <span
                          style={{
                            color: 'var(--text-muted)',
                            fontSize: 'var(--text-xs)',
                          }}
                        >
                          {' '}
                          ({r.actorRoleCodes.join(', ')})
                        </span>
                      ) : null}
                    </Td>
                    <Td>{r.action}</Td>
                    <Td>
                      <Badge tone={tone(r.outcome)}>{r.outcome}</Badge>
                    </Td>
                    <Td variant="identifier">
                      {r.subjectPatientId ? (
                        <Link href={`/audit?patient=${r.subjectPatientId}`}>
                          {r.subjectPatientMrn ?? 'patient'}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td variant="identifier">
                      {r.entityType ?? '—'}
                      {r.entityId ? ` ${r.entityId.slice(0, 8)}` : ''}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableContainer>

          {result.pageCount > 1 ? (
            <nav
              aria-label="Pagination"
              style={{
                display: 'flex',
                gap: 'var(--space-3)',
                fontSize: 'var(--text-sm)',
              }}
            >
              {result.page > 1 ? (
                <Link href={pageHref(result.page - 1)}>Previous</Link>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>Previous</span>
              )}
              <span aria-current="page">
                Page {result.page} of {result.pageCount}
              </span>
              {result.page < result.pageCount ? (
                <Link href={pageHref(result.page + 1)}>Next</Link>
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
