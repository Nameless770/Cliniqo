/**
 * Load a large synthetic clinic into the development database.
 *
 *     npm run db:seed-bulk            # ~1,500 patients
 *     DATASET_SCALE=5 npm run db:seed-bulk   # ~7,500 patients
 *
 * For clicking around a populated application, and for seeing whether a page that feels
 * instant with one patient still feels instant with thousands. The same generator backs
 * tests/db/performance.test.ts, so what you are looking at is what CI measures.
 *
 * REFUSES TO RUN AGAINST PRODUCTION, twice over: once on APP_ENV and once on
 * ALLOW_SEED_DATA. Every row it writes is synthetic (164.514) but it is still thousands of
 * fabricated patients, and a fabricated patient in a real clinic's database is a data
 * integrity incident even though it is not a privacy one.
 *
 * It ADDS a clinic rather than clearing anything. Nothing existing is touched, so it is
 * safe to run twice - you simply get two practices.
 */

import { Pool } from 'pg';

import { seedLargeDataset } from '../tests/helpers/dataset.ts';

const appEnv = (process.env.APP_ENV ?? 'development').toLowerCase();
if (appEnv === 'production') {
  console.error('[seed-bulk] Refusing to run against APP_ENV=production.');
  process.exit(2);
}

if ((process.env.ALLOW_SEED_DATA ?? 'false') !== 'true') {
  console.error('[seed-bulk] ALLOW_SEED_DATA must be true. Refusing.');
  process.exit(2);
}

const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error('[seed-bulk] DATABASE_MIGRATION_URL is not set.');
  process.exit(2);
}

const scale = Number(process.env.DATASET_SCALE ?? 1);
const months = Number(process.env.DATASET_MONTHS ?? 6);

const pool = new Pool({
  connectionString: url,
  ssl: (process.env.DATABASE_SSL ?? 'require') === 'disable' ? false : { rejectUnauthorized: true },
});

const started = Date.now();
console.log(`[seed-bulk] generating at scale ${scale}, ${months} months of history...`);

try {
  const data = await seedLargeDataset((sql, params) => pool.query(sql, params), {
    scale,
    months,
    /* A fresh seed per run, so repeated runs produce different practices rather than
       colliding on the MRN unique index. The tests pass a fixed one. */
    seed: Date.now() % 2147483647,
  });

  console.log(`[seed-bulk] clinic ${data.clinicId}`);
  console.log(`  patients      ${data.counts.patients}`);
  console.log(`  appointments  ${data.counts.appointments}`);
  console.log(`  invoices      ${data.counts.invoices}`);
  console.log(`  audit events  ${data.counts.auditEvents}`);
  console.log(`[seed-bulk] done in ${Date.now() - started}ms`);
  console.log();
  console.log('  Staff accounts have no usable password — sign in with an existing');
  console.log('  account, or issue a link with `npm run staff:setup-link <email>`.');
} finally {
  await pool.end();
}
