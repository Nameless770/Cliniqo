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

  /*
   * Pre-compute the decoy password hash.
   *
   * The login path verifies against it when an email does not exist, so that "no such
   * account" costs the same wall-clock time as "wrong password". Computing it lazily
   * would make the FIRST unknown-email attempt after a restart ~2x slower than the
   * rest — a one-shot enumeration signal, but a free one to remove.
   *
   * Not awaited: it takes a few hundred milliseconds and nothing needs it until the
   * first login, so it warms in the background rather than delaying readiness.
   */
  const { decoyHash } = await import('./server/auth/password');
  void decoyHash();

  console.info('[startup] environment validated');
}
