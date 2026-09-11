import { NextResponse } from 'next/server';

import { getSession, sessionCookieOptions } from '@/server/auth/session';
import {
  OAUTH_COOKIE,
  OAUTH_TTL_SECONDS,
  authorizeUrl,
  googleConfig,
  newHandshake,
} from '@/server/auth/google';

/**
 * Leg one: send the browser to Google.
 *
 * A ROUTE HANDLER, not a server action — CLAUDE.md prefers actions except for third-party
 * callbacks, and this is one half of exactly that. It has to produce a redirect to an
 * external origin with a `Set-Cookie` attached, which is a response shape an action cannot
 * express.
 *
 * POST ONLY. A GET would be triggerable by any `<img src>` or link prefetch on any page
 * the user visits, quietly burning through handshakes and, worse, letting an attacker
 * start a flow of their choosing. The sign-in page submits a real form.
 */
export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  const config = googleConfig();
  // Not configured: the feature does not exist rather than failing loudly.
  if (!config) return NextResponse.redirect(new URL('/login', 'http://localhost'), 303);

  // Already signed in — don't start a second identity flow over a live session.
  if (await getSession()) {
    return NextResponse.redirect(new URL('/dashboard', config.redirectUri), 303);
  }

  const handshake = newHandshake();
  const response = NextResponse.redirect(authorizeUrl(config, handshake), 303);

  /*
   * State, nonce and the PKCE verifier, held in one short-lived cookie.
   *
   * `sameSite: 'lax'` deliberately, not `strict`: the browser arrives back from
   * accounts.google.com as a top-level GET, and a strict cookie would not be sent on that
   * navigation — the callback would then see no handshake and refuse every legitimate
   * sign-in. Lax is the correct setting for exactly this shape, and the `state` check is
   * what provides the CSRF protection rather than the cookie's SameSite alone.
   */
  response.cookies.set(OAUTH_COOKIE, JSON.stringify(handshake), {
    ...sessionCookieOptions(),
    maxAge: OAUTH_TTL_SECONDS,
  });

  return response;
}
