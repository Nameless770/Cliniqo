import { NextResponse, type NextRequest } from 'next/server';

/**
 * Content-Security-Policy with a per-request nonce — security review finding F2.
 *
 * ==========================================================================
 * THIS IS NOT AN AUTHENTICATION BOUNDARY
 * ==========================================================================
 *
 * Middleware runs on the Edge runtime and CANNOT reach PostgreSQL, so it cannot validate
 * a session — the most it could check is that a cookie exists, which is not authentication.
 * Earlier phases deliberately shipped no middleware for exactly that reason: a file that
 * looks like a gate but only checks for the presence of a string is worse than no file,
 * because the next person assumes it is doing something.
 *
 * It exists solely to emit a CSP nonce. Session and permission checks remain where they
 * were: `(staff)/layout.tsx` for navigation, and `requirePermission` inside every
 * operation. Do not add access control here.
 *
 * ==========================================================================
 * WHAT IT FIXES
 * ==========================================================================
 *
 * The policy previously carried `script-src 'self' 'unsafe-inline'`, which permits inline
 * script execution — the primary XSS payload channel, on an application that renders PHI
 * into the DOM.
 *
 * Next needs SOME way to run its inline bootstrap. Given a nonce in the CSP header set
 * from middleware, Next stamps that nonce onto its own inline scripts, so `'unsafe-inline'`
 * can be dropped entirely. `'strict-dynamic'` then lets those trusted scripts load the
 * chunks they need without allowlisting hashes.
 *
 * Styles still carry `'unsafe-inline'`. The application uses inline `style` attributes
 * throughout, and a style-src nonce cannot cover attribute styles. The XSS value of
 * inline CSS is far lower than inline script — it enables data exfiltration through
 * selectors in narrow cases, all of which `connect-src 'self'` already blocks.
 */
export function middleware(request: NextRequest) {
  // 128 bits, base64. Fresh per request — a reused nonce is no nonce.
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  /*
   * `'unsafe-eval'` — DEVELOPMENT ONLY, and it must stay that way.
   *
   * React's development build calls eval() to rebuild stack traces across the
   * server/client boundary. Denying it does not make the dev server safer in any
   * meaningful sense — it runs on loopback with synthetic data — but it does strip the
   * error reporting, which is how a plain "database is down" surfaced as an opaque
   * `ERROR 932402932` digest with no message. A control that only degrades diagnostics
   * is a control that costs debugging time and buys nothing.
   *
   * `process.env.NODE_ENV` is inlined by the bundler, so in a production build this is
   * the literal `false` and the directive is dead-code eliminated — it cannot be turned
   * on by an environment variable at runtime. Production keeps nonce + strict-dynamic
   * with no eval, which is the policy that actually matters on a page rendering PHI.
   */
  /*
   * The one raw `process.env` read that is not just permitted but REQUIRED.
   *
   * The validated `env` module is server-only and cannot be imported into the Edge
   * runtime. More importantly, the safety of this line comes precisely from it being a
   * literal `process.env.NODE_ENV` that the bundler substitutes at build time — reading
   * the same value through a validated accessor would make it a runtime lookup, and a
   * runtime lookup is one misconfigured variable away from shipping 'unsafe-eval' to
   * production. Disabled for this line only, not the file.
   */
  // eslint-disable-next-line no-restricted-properties
  const devEval = process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '';

  const csp = [
    "default-src 'self'",
    // No 'unsafe-inline'. Next applies this nonce to its own bootstrap scripts.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${devEval}`,
    // Retained: inline style ATTRIBUTES cannot be nonced, and are used throughout.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    /*
     * No third-party origin. This is the control that bounds an XSS: even executing
     * script cannot post a chart to an external host. Any future entry here is a PHI
     * egress path and needs a BAA before it needs a code review.
     */
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    // Blocks <base>-style downgrade tricks and mixed content in one line.
    'upgrade-insecure-requests',
  ].join('; ');

  // Next reads the nonce back off the request header to stamp its inline scripts.
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);

  /*
   * The current path, for the `(staff)` layout.
   *
   * A layout receives no pathname in the App Router, and the forced-password-change
   * redirect has to know whether it is already ON the password page or it loops forever.
   * This is a REQUEST header set by our own middleware, so it is not attacker-controlled
   * the way an inbound header would be — `new Headers(request.headers)` then `.set()`
   * overwrites any value a client tried to send under the same name.
   *
   * Still not access control: it decides where to send someone, never what they may read.
   */
  headers.set('x-pathname', request.nextUrl.pathname);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);

  return response;
}

export const config = {
  /*
   * Skip static assets and the health probe.
   *
   * A CSP on a JS chunk or an image does nothing, and the health endpoint is polled
   * constantly by an orchestrator that renders no HTML — generating a nonce for each poll
   * is pure waste.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/health).*)'],
};
