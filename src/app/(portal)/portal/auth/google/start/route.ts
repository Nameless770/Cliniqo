import { NextResponse } from 'next/server';

import { authorizeUrl, newHandshake, OAUTH_TTL_SECONDS } from '@/server/auth/google';
import { PORTAL_OAUTH_COOKIE, portalGoogleConfig } from '@/server/portal/google';
import { getPatientSession, portalCookieOptions } from '@/server/portal/session';

/**
 * Leg one of the patient flow: send the browser to Google.
 *
 * A ROUTE HANDLER rather than a server action, for the same reason as the staff one —
 * CLAUDE.md prefers actions except for third-party callbacks, and this is half of exactly
 * that. It has to answer with a redirect to an external origin carrying a `Set-Cookie`,
 * which is not a response shape an action can express.
 *
 * POST ONLY, and this matters more here than on the staff side. A GET would fire from any
 * `<img src>`, link prefetch or embedded resource on any page the patient happens to
 * visit — and the mere redirect is the disclosure this feature is careful about. It must
 * only ever happen because the patient pressed a button under a notice explaining it.
 *
 * ==========================================================================
 * WHY THE FEATURE-OFF CASE IS A PLAIN REDIRECT, NOT A 404 OR A 500
 * ==========================================================================
 *
 * When PORTAL_GOOGLE_SIGN_IN is false this route exists but does nothing except send the
 * browser back to the login page. The clinic that has not enabled it renders no button,
 * so nothing reaches here in normal use; anything that does is a probe, and a probe
 * learns only that the portal has a login page.
 */
export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  const config = portalGoogleConfig();
  // Not enabled: behave as though the feature does not exist.
  if (!config) {
    return NextResponse.redirect(new URL('/portal/login', 'http://localhost'), 303);
  }

  // Already signed in — don't start an identity flow over a live session.
  if (await getPatientSession()) {
    return NextResponse.redirect(new URL('/portal', config.redirectUri), 303);
  }

  const handshake = newHandshake();
  const response = NextResponse.redirect(authorizeUrl(config, handshake), 303);

  /*
   * State, nonce and the PKCE verifier in one short-lived cookie, under the PORTAL name.
   *
   * `sameSite: 'lax'` deliberately, not `strict`: the browser returns from
   * accounts.google.com as a top-level GET, and a strict cookie would not be sent on that
   * navigation — the callback would then see no handshake and refuse every legitimate
   * sign-in. `state` is what provides the CSRF protection, not the cookie's SameSite.
   */
  response.cookies.set(PORTAL_OAUTH_COOKIE, JSON.stringify(handshake), {
    ...portalCookieOptions(),
    maxAge: OAUTH_TTL_SECONDS,
  });

  return response;
}
