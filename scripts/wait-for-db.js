/**
 * Blocks until the local database accepts connections.
 *
 * `docker compose up -d` returns as soon as the container is started, not when Postgres
 * is ready to serve — running migrations immediately after it fails intermittently.
 *
 * Local development only.
 */

import { Client } from 'pg';

const url =
  process.env.DATABASE_MIGRATION_URL ??
  'postgres://cliniqo_owner:cliniqo_local_dev@127.0.0.1:5432/cliniqo';

const deadline = Date.now() + 60_000;

while (Date.now() < deadline) {
  const client = new Client({ connectionString: url, ssl: false });
  try {
    await client.connect();
    await client.query('select 1');
    await client.end();
    console.log('[wait-for-db] ready.');
    process.exit(0);
  } catch {
    await client.end().catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));
  }
}

console.error('[wait-for-db] database did not become ready within 60s.');
process.exit(1);
