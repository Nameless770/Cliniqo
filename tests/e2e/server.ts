import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * A real Next server, on its own port, pointed at the TEST database.
 *
 * Not the developer's running dev server. Two reasons, and the second is the one that
 * matters: a suite that writes to the development database corrupts the data someone is
 * working with, and — far worse — a suite that reads it would be asserting against real
 * appointment and patient rows. The test database is rebuilt from migrations before every
 * run, so what these journeys see is only what they created.
 */

const TEST_DB = process.env['TEST_DATABASE_NAME'] ?? 'cliniqo_test';
/** Separate from `.next`, so a running dev server's build output is never clobbered. */
const DIST_DIR = '.next-e2e';

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — run the suite via \`npm test\`.`);
  return value;
}

export type RunningApp = {
  baseUrl: string;
  stop: () => Promise<void>;
};

/**
 * Boot the app and wait until it actually serves.
 *
 * A PRODUCTION build, served by `next start`, for three reasons:
 *
 *   1. `next dev` refuses to run twice against one directory, so the suite would fight
 *      whatever dev server the developer already has open.
 *   2. It is what actually ships. The CSP these journeys assert on differs between the
 *      two — development permits 'unsafe-eval' for React's error overlay — so asserting
 *      against the dev server would be asserting against a policy no patient ever gets.
 *   3. No compile-on-first-request, so a journey measures the application rather than a
 *      bundler.
 *
 * It builds into its own directory (NEXT_DIST_DIR), so it cannot clobber the `.next` a
 * running dev server owns.
 *
 * Readiness is a successful request to the health endpoint, not a log line: the banner is
 * printed before the server is actually accepting requests.
 */
export async function startApp(): Promise<RunningApp> {
  // A port derived from the process id, so a parallel checkout does not collide.
  const port = 3200 + (process.pid % 300);
  const baseUrl = `http://127.0.0.1:${port}`;

  /*
   * Next's own binary under this node, not `npm run dev`. Node refuses to spawn a `.cmd`
   * shim without a shell (EINVAL since the 2024 argument-injection fix), and going
   * through a shell to work around that would mean quoting a path that, on this machine,
   * contains both spaces and a `+`. One less layer is also one less process to leak.
   */
  const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');

  const appEnv = {
    ...process.env,
    APP_ENV: 'test',
    NEXT_DIST_DIR: DIST_DIR,
    /*
     * Google sign-in is CONFIGURED for the journeys, with credentials that are never
     * used. Leaving it unset made the callback journey pass for the wrong reason: the
     * route returns early when the feature is off, so a forged state redirected to
     * /login without the CSRF check ever running. Configuring it means the handshake
     * check is the thing actually under test. No request ever reaches Google — every
     * assertion is on a refusal that happens before the token exchange.
     */
    APP_URL: baseUrl,
    GOOGLE_CLIENT_ID: 'e2e-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'e2e-client-secret-never-used',
    /*
     * And the patient half switched ON, for the same reason. It is off by default — a
     * deployment that has not enabled it renders no button and its routes return early,
     * so leaving it off here would make every portal SSO assertion pass by the feature
     * being absent rather than by its checks running.
     */
    PORTAL_GOOGLE_SIGN_IN: 'true',
    DATABASE_URL: withDatabase(required('DATABASE_URL'), TEST_DB),
    DATABASE_MIGRATION_URL: withDatabase(required('DATABASE_MIGRATION_URL'), TEST_DB),
    /* The journeys assert on triage behaviour, and they must assert on the engine that
       ships by default — never on a third party, which would make the suite both flaky
       and a PHI disclosure. */
    TRIAGE_ENGINE: 'local',
  };

  execFileSync(process.execPath, [nextBin, 'build'], {
    cwd: process.cwd(),
    env: { ...appEnv, NODE_ENV: 'production' },
    stdio: 'pipe',
  });

  const child: ChildProcess = spawn(
    process.execPath,
    [nextBin, 'start', '--port', String(port)],
    {
      cwd: process.cwd(),
      env: {
        ...appEnv,
        NODE_ENV: 'production',
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    },
  );

  const log: string[] = [];
  child.stdout?.on('data', (d: Buffer) => log.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => log.push(d.toString()));

  const deadline = Date.now() + 120_000;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`app exited early (${child.exitCode}):\n${log.join('')}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        return {
          baseUrl,
          stop: () =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null) return resolve();
              child.once('exit', () => resolve());
              child.kill('SIGTERM');
              // Next spawns a worker; if the tree ignores SIGTERM, take it down hard.
              setTimeout(() => {
                if (child.exitCode === null) child.kill('SIGKILL');
                resolve();
              }, 5000);
            }),
        };
      }
      lastError = `health responded ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  child.kill('SIGKILL');
  throw new Error(`app did not become ready: ${lastError}\n${log.join('')}`);
}
