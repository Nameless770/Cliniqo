/**
 * Shim for `import 'server-only'` under vitest.
 *
 * The real package throws unless it is resolved through the `react-server` condition,
 * which the app's build sets but the test runner does not. The integration tests import
 * real server modules (the audited data-access layer is the whole point), so every one of
 * them would fail at import on that guard. Aliasing `server-only` here to an empty module
 * removes the guard for tests only — the production boundary is unchanged, and the ESLint
 * client/server import rules still enforce it where it matters.
 */
export {};
