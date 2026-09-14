import 'server-only';

import { cookies } from 'next/headers';

import { getEnv } from '@/env/server';
import { signToken, verifyToken } from '@/lib/signed-token';
import { portalCookieOptions } from '@/server/portal/session';

import type { GoogleIdentity } from './google';
import { sessionCookieOptions } from './session';

/**
 * The step between "Google says who you are" and "your account exists".
 *
 * When Google sign-in finds no account and self-registration is on, the callback does not
 * create one. It issues this short-lived signed token and sends the person to a page that
 * says what is about to happen and asks them to confirm. Creating on the callback itself
 * would turn a colleague picking the wrong Google account in the chooser — personal instead
 * of work — into a stray account nobody asked for.
 *
 * Two audiences, two cookie names, two paths. A staff token is never readable on the patient
 * sign-up page or the reverse, the same separation the two Google callbacks already keep.
 */

export type SignupAudience = 'staff' | 'portal';

export type PendingSignup = {
  aud: SignupAudience;
  /** Google's stable subject. What the new account is linked to. */
  sub: string;
  /** Verified by Google. The only address a sign-up can ever use. */
  email: string;
  name: string | null;
  givenName: string | null;
  familyName: string | null;
  exp: number;
};

/** Long enough to type a name and a date of birth; short enough that a shared computer forgets. */
export const PENDING_SIGNUP_TTL_SECONDS = 15 * 60;

const PURPOSE = 'pending-signup';

const COOKIE: Record<SignupAudience, string> = {
  staff: 'cliniqo_signup',
  portal: 'cliniqo_portal_signup',
};

/*
 * Scoped to the page that consumes it. The browser will not send the token anywhere else on
 * the site, and the sign-up form's server action posts back to that same path.
 */
const PATH: Record<SignupAudience, string> = {
  staff: '/signup',
  portal: '/portal/signup',
};

export function pendingSignupCookie(audience: SignupAudience) {
  const base = audience === 'staff' ? sessionCookieOptions() : portalCookieOptions();
  return {
    name: COOKIE[audience],
    options: { ...base, path: PATH[audience], maxAge: PENDING_SIGNUP_TTL_SECONDS },
  };
}

/**
 * The clinic new accounts join, or null when self-registration is off for this audience.
 * Every entry point checks this first and behaves as though the feature does not exist.
 */
export function signupClinicId(audience: SignupAudience): string | null {
  const env = getEnv();
  const enabled = audience === 'staff' ? env.STAFF_SELF_SIGNUP : env.PORTAL_SELF_SIGNUP;
  return enabled && env.SIGNUP_CLINIC_ID ? env.SIGNUP_CLINIC_ID : null;
}

/**
 * Only ever called with an identity whose email Google has VERIFIED — the callbacks check
 * `email_verified` before reaching the point where this is issued.
 */
export function mintPendingSignup(
  audience: SignupAudience,
  identity: GoogleIdentity,
  nowMs: number,
): string {
  return signToken(
    {
      aud: audience,
      sub: identity.subject,
      email: identity.email,
      name: identity.name,
      givenName: identity.givenName,
      familyName: identity.familyName,
      exp: nowMs + PENDING_SIGNUP_TTL_SECONDS * 1000,
    },
    getEnv().SESSION_SECRET,
    PURPOSE,
  );
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/**
 * The verified pending sign-up for this audience, or null.
 *
 * Checks the audience INSIDE the signed payload as well as the cookie name. The name keeps
 * the two flows apart in the browser; the payload check keeps them apart even if a token
 * were copied from one cookie into the other.
 */
export async function readPendingSignup(
  audience: SignupAudience,
): Promise<PendingSignup | null> {
  const jar = await cookies();
  const payload = verifyToken(
    jar.get(COOKIE[audience])?.value,
    getEnv().SESSION_SECRET,
    PURPOSE,
    Date.now(),
  );
  if (!payload || payload['aud'] !== audience) return null;

  const sub = text(payload['sub']);
  const email = text(payload['email']);
  if (!sub || !email) return null;

  return {
    aud: audience,
    sub,
    email,
    name: text(payload['name']),
    givenName: text(payload['givenName']),
    familyName: text(payload['familyName']),
    exp: payload['exp'] as number,
  };
}

/**
 * Cleared from the browser as soon as it has been spent, whether or not the sign-up succeeded.
 *
 * The token itself is stateless, so a copy taken earlier stays validly signed until it expires.
 * What stops a replay creating anything is the account it would create already existing: the
 * address and the Google subject are both unique, and a second attempt is refused on them.
 */
export async function clearPendingSignup(audience: SignupAudience): Promise<void> {
  const jar = await cookies();
  const { name, options } = pendingSignupCookie(audience);
  jar.set(name, '', { ...options, maxAge: 0 });
}
