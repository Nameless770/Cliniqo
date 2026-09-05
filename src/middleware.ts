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

  const csp = [
    "default-src 'self'",
    // No 'unsafe-inline'. Next applies this nonce to its own bootstrap scripts.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
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
