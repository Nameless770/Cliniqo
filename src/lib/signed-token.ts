import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A small signed, expiring token: `base64url(json).base64url(hmac-sha256)`.
 *
 * Used for exactly one thing — carrying a Google-verified identity from the OAuth callback
 * to the sign-up form a moment later — and deliberately not a general-purpose JWT.
 *
 * ==========================================================================
 * WHY SIGNED, AND WHY NOT A DATABASE ROW
 * ==========================================================================
 *
 * The form that completes a sign-up trusts this token to say which Google account the
 * person proved they control. If it could be edited, anyone could claim someone else's
 * address and subject, create an account under it, and be sitting inside it when the real
 * owner later signed in with Google. The HMAC is what makes that impossible.
 *
 * It lives in a cookie rather than a table so that a person who opens the sign-up page and
 * walks away leaves nothing behind. A row per abandoned sign-up would be a list of people
 * who considered becoming patients of this clinic, retained for no reason.
 *
 * Pure — the secret is a parameter — so the e2e suite can mint a token with the test
 * server's secret and drive the real sign-up form without a trip through Google.
 */

const b64 = (buffer: Buffer): string => buffer.toString('base64url');

/*
 * A key derived per purpose, never the raw session secret. If this construction were ever
 * misused elsewhere, a signature minted here must not verify there, and vice versa.
 */
function keyFor(secret: string, purpose: string): Buffer {
  return createHmac('sha256', secret).update(`cliniqo:${purpose}:v1`).digest();
}

export function signToken(
  payload: Record<string, unknown> & { exp: number },
  secret: string,
  purpose: string,
): string {
  const body = b64(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = b64(createHmac('sha256', keyFor(secret, purpose)).update(body).digest());
  return `${body}.${signature}`;
}

/**
 * The payload, or null for anything wrong: malformed, altered, signed for another purpose,
 * or expired. One null for every failure, so a caller cannot build different behaviour on
 * reasons it has no business distinguishing.
 */
export function verifyToken(
  token: string | undefined,
  secret: string,
  purpose: string,
  nowMs: number,
): Record<string, unknown> | null {
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts as [string, string];

  const expected = createHmac('sha256', keyFor(secret, purpose)).update(body).digest();
  const given = Buffer.from(signature, 'base64url');
  /* Length first: timingSafeEqual throws on unequal lengths, which would itself be a signal. */
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;

  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp !== 'number' || exp <= nowMs) return null;

  return payload as Record<string, unknown>;
}
