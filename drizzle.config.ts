import { defineConfig } from 'drizzle-kit';

// Node 22+ built-in. Avoids a dotenv dependency — every dependency in a PHI application
// is a supply-chain surface, and this one buys nothing.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file (CI, container with injected env). Not an error.
}

/**
 * drizzle-kit reads this for `generate`, `migrate`, `check`, and `studio`.
 *
 * Note the credential: DATABASE_MIGRATION_URL, not DATABASE_URL.
 *
 * These are two different PostgreSQL roles on purpose. The runtime role deliberately
 * lacks UPDATE and DELETE on `audit_event` (see migration 0001), so it cannot run DDL
 * either. Migrations connect as the schema owner; the application never does. If they
 * were the same role, the audit-log immutability guarantee would be decorative.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url:
      process.env.DATABASE_MIGRATION_URL ??
      process.env.DATABASE_URL ??
      'postgres://cliniqo_owner:cliniqo@localhost:5432/cliniqo',
  },
  // Fail loudly on ambiguous diffs rather than guessing at a destructive statement.
  strict: true,
  verbose: true,
});
