/**
 * Next.js runs `register()` once per server process, before the first request is served.
 *
 * This is the fail-fast hook. Validating configuration here means a missing
 * SESSION_SECRET or a production deployment with TLS disabled stops the container at
 * boot — where a health check catches it and the rollout halts — rather than surfacing
 * as a 500 the first time a receptionist tries to log in.
 */

export async function register() {
  // Edge and browser runtimes have no access to server secrets, and importing the
  // server env there would be a build error. Only validate on Node.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { loadServerEnv } = await import('./env/server');
  loadServerEnv();

  console.info('[startup] environment validated');
}
