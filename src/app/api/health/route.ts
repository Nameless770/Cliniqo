import { sql } from 'drizzle-orm';

import { getDb } from '@/db/client';

/**
 * Liveness / readiness probe.
 *
 * One of the few legitimate reasons to use a route handler rather than a server action:
 * the caller is a load balancer or orchestrator, not a browser.
 *
 * Deliberately unauthenticated — a probe cannot log in — and therefore deliberately
 * uninformative. It returns whether the service can serve traffic and nothing else: no
 * version string, no database hostname, no error text. An unauthenticated endpoint that
 * echoes internals is a free reconnaissance tool.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    await getDb().execute(sql`select 1`);

    return Response.json(
      { status: 'ok' },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    // Logged server-side for operators; never returned to the caller.
    console.error(
      '[health] database check failed:',
      error instanceof Error ? error.message : 'unknown error',
    );

    return Response.json(
      { status: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
