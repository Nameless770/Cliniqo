import { NextResponse, type NextRequest } from 'next/server';

import {
  exchangeCode,
  statesMatch,
  type GoogleIdentity,
  type OAuthHandshake,
} from '@/server/auth/google';
import { checkIpRateLimit, recordAttempt } from '@/server/auth/rate-limit';
import { requestMeta, safeInet } from '@/server/auth/session';
import {
  PORTAL_OAUTH_COOKIE,
  portalGoogleConfig,
  signInPatientWithGoogle,
} from '@/server/portal/google';
import { portalCookieName, portalCookieOptions } from '@/server/portal/session';

/**
 * Leg two of the patient flow: Google sends the browser back.
 *
 * ==========================================================================
 * A SEPARATE DOOR FROM THE STAFF CALLBACK, ON PURPOSE
 * ==========================================================================
 *
 * This handler reads only `cliniqo_portal_oauth` and resolves only against
 * `patient_account`; the staff handler reads only `cliniqo_oauth` and resolves only
 * against `user_account`. Neither can be reached with the other's handshake, so a
 * patient's Google sign-in cannot be steered into the staff door to find out whether
 * their address also belongs to a staff account — and cannot mint a staff session if it
 * does. The two flows share arithmetic and nothing else.
 *
 * ==========================================================================
 * IT LINKS. IT NEVER CREATES.
 * ==========================================================================
 *
 * A successful Google sign-in proves who is at the keyboard. It does not make anyone a
 * patient of this clinic — staff do that, and staff issue the portal account. So this
 * ends in a refusal unless a matching, active portal account already exists.
 *
 * ONE GENERIC FAILURE for every rejection: a bad state, a stale handshake, an unverified
 * address, an unknown account, a suspended one. Distinguishing them would turn the portal
 * login page into an oracle for which email addresses belong to patients of this
 * practice — which is the precise fact this whole feature is built to keep from leaking.
 */
export const dynamic = 'force-dynamic';

const FAILURE = '/portal/login?error=sso';
/* An infrastructure failure, not a refusal. See the try/catch below for why the two
   are allowed to be distinguishable when no other refusal is. */
const UNAVAILABLE = '/portal/login?error=unavailable';

function parseHandshake(raw: string | undefined): OAuthHandshake | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const h = parsed as Record<string, unknown>;
    return typeof h['state'] === 'string' &&
      typeof h['nonce'] === 'string' &&
      typeof h['codeVerifier'] === 'string'
      ? { state: h['state'], nonce: h['nonce'], codeVerifier: h['codeVerifier'] }
      : null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const config = portalGoogleConfig();
  if (!config) return NextResponse.redirect(new URL('/portal/login', request.url), 303);

  const base = config.redirectUri;

  const response = (target: string) => {
    const res = NextResponse.redirect(new URL(target, base), 303);
    // The handshake is single-use whatever the outcome; clearing it prevents replay.
    res.cookies.set(PORTAL_OAUTH_COOKIE, '', { ...portalCookieOptions(), maxAge: 0 });
    return res;
  };

  const handshake = parseHandshake(request.cookies.get(PORTAL_OAUTH_COOKIE)?.value);
  const returnedState = request.nextUrl.searchParams.get('state');
  const code = request.nextUrl.searchParams.get('code');

  /* The CSRF check. Without it an attacker can complete a flow of their own choosing in
     the patient's browser and land them inside the attacker's account. */
  if (!handshake || !returnedState || !statesMatch(handshake.state, returnedState)) {
    return response(FAILURE);
  }
  if (!code) return response(FAILURE);

  /*
   * ==========================================================================
   * EVERYTHING BELOW TOUCHES THE DATABASE
   * ==========================================================================
   *
   * The rate limiter, the account resolution and the audit write all require
   * PostgreSQL. When it is unreachable, every one of them throws.
   *
   * A throw here would skip the `response()` helper entirely, so the handshake cookie
   * would survive the failed attempt -- and the comment in that helper promises it is
   * single-use WHATEVER the outcome. Catching is what keeps that true.
   *
   * A separate outcome from FAILURE, and safe to distinguish: the generic-refusal rule
   * exists so this page cannot be asked which addresses hold accounts, and an outage
   * answers identically for every address, so it reveals nothing about any of them.
   * Telling somebody "try again" when the truth is "our database is down" would just
   * send them to look for a mistake they did not make.
   *
   * The error itself is deliberately NOT logged. A pg error carries parameter values
   * in its detail fields, and in this application those parameters are patient data.
   */
  try {
    const { ip: rawIp, userAgent } = await requestMeta();
    const ip = safeInet(rawIp);

    /*
     * The same per-IP budget the password login uses. This door leads to the same records,
     * so it gets the same limiter — an SSO path that skips it is simply the cheaper way in.
     */
    const verdict = await checkIpRateLimit(ip);
    if (!verdict.allowed) return response(FAILURE);

    let identity: GoogleIdentity | null = null;
    try {
      identity = await exchangeCode(config, code, handshake.codeVerifier);
    } catch {
      identity = null;
    }
    if (!identity) return response(FAILURE);

    /* The nonce binds this ID token to the handshake we started, so a token minted for some
       other request cannot be replayed into this one. */
    if (identity.nonce !== handshake.nonce) return response(FAILURE);

    /* An unverified address is a claim, not a fact — anyone can put a string in a profile,
       and this one resolves straight to somebody's medical record. */
    if (!identity.emailVerified) return response(FAILURE);

    const result = await signInPatientWithGoogle(identity, ip, userAgent);

    /*
     * Recorded whichever way it went, and deliberately WITHOUT `userId`/`clinicId`: those
     * columns reference staff accounts, and a patient is not one. Same shape the portal
     * password login already uses.
     */
    await recordAttempt({ email: identity.email, ip, succeeded: result.ok });

    if (!result.ok) return response(FAILURE);

    /*
     * `linked=1` on the first sign-in only, so the portal can confirm what just happened
     * and show where to undo it. A boolean about the sign-in method — no PHI, nothing that
     * identifies anyone, and nothing a referrer header could leak about a patient.
     */
    const success = response(result.linked ? '/portal?linked=1' : '/portal');
    success.cookies.set(portalCookieName(), result.token, {
      ...portalCookieOptions(),
      expires: result.expiresAt,
    });
    return success;
  } catch {
    return response(UNAVAILABLE);
  }
}
