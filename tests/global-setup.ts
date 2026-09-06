import { execFileSync } from 'node:child_process';

/**
 * Rebuild the test database once, before any test file runs.
 *
 * Every run starts from the checked-in migrations. That is deliberate: it means a test
 * cannot pass because of a schema change someone applied by hand and never wrote down,
 * and it means the migrations themselves are exercised on every single run.
 */
export default function setup() {
  if ((process.env['APP_ENV'] ?? '').toLowerCase() === 'production') {
    throw new Error('Refusing to run database tests against a production environment.');
  }

  execFileSync(process.execPath, ['scripts/test-db.js'], {
    stdio: 'inherit',
    env: process.env,
  });
}
