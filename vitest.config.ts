import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/*
 * Load .env here rather than relying on the npm script.
 *
 * `next dev` and the node scripts get it from --env-file-if-exists, but vitest is its own
 * binary and an IDE's "run test" button bypasses package.json entirely. Loading it in the
 * config means the suite works however it is invoked, instead of failing with a confusing
 * "DATABASE_MIGRATION_URL is not set" the first time someone runs it from an editor.
 *
 * Values already present in the environment win, so CI can point the suite at its own
 * service container without a .env file existing at all.
 */
try {
  process.loadEnvFile('.env');
} catch {
  // No .env — expected in CI, where the variables come from the environment.
}

/**
 * Database-backed test configuration.
 *
 * These tests exist because the guarantees they cover were each proven ONCE, by hand, by
 * an ad-hoc script that was then deleted — the exact decay the invariant suite warns
 * about in its own header. The static invariants deliberately run without a database;
 * these are the other half, and they need Postgres.
 *
 * NO PARALLELISM. Every test file shares one database, and several of them count rows or
 * fire concurrent writes at a single constraint. Running files in parallel would make the
 * double-booking test race against unrelated inserts and fail intermittently — and an
 * intermittently failing security test gets muted, which is worse than not having it.
 */
export default defineConfig({
  // Same '@' alias as tsconfig, so a test can import the application's own predicates
  // instead of restating them and drifting from what actually ships.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // See tests/helpers/empty.ts. The integration tests import the real audited layer,
      // whose modules open with `import 'server-only'`; that guard needs the react-server
      // condition the runner does not set, so it is shimmed to a no-op for tests only.
      'server-only': fileURLToPath(new URL('./tests/helpers/empty.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Rebuilds the test database before the suite, so every run starts from the real
    // migrations rather than from whatever the last run left behind.
    globalSetup: ['tests/global-setup.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    // Seeding, migrating and 20 concurrent transactions are slower than a unit test.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
