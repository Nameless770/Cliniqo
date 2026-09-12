import 'server-only';

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { getEnv } from '@/env/server';

/**
 * Google sign-in for STAFF, as an OAuth 2.0 authorization-code flow with PKCE.
 *
 * ==========================================================================
 * THE STAFF HALF. PATIENTS ARE `@/server/portal/google`
 * ==========================================================================
 *
 * The two audiences share everything in this file — PKCE, state, nonce, the token
 * exchange — and share nothing else: different redirect URI, different handshake cookie,
 * different callback route, different resolver, different session table. So a handshake
 * begun on the portal cannot be completed here, and a patient's sign-in cannot resolve to
 * a staff session even when the same human holds both.
 *
 * They are also not the same decision, and the asymmetry is worth stating where somebody
 * will read it. A staff member signing in with Google tells Google that one of its users
 * authenticated to an application; they are an employee, and that is not health
 * information about anybody. A PATIENT signing in the same way tells Google that a
 * specific identified person holds an account at a specific medical practice — which is
 * to say, that they receive care there. That is health information about that person.
 *
 * So the patient flow is off by default, is opt-in per patient with the disclosure stated
 * before the click, records the authorization, and can be withdrawn. None of which
 * applies here. Configuring this file's credentials does not switch that on; only
 * PORTAL_GOOGLE_SIGN_IN does.
 *
 * ==========================================================================
 * NO SDK, AND NO GOOGLE JAVASCRIPT
 * ==========================================================================
 *
 * The entire flow is server-side redirects and one server-to-server POST. Google Identity
 * Services would mean a third-party script and a `connect-src` entry, and this
 * application's CSP is `script-src 'self' 'nonce-…' 'strict-dynamic'` with
 * `connect-src 'self'` precisely so that an XSS cannot reach any external origin. Buying a
 * nicer button with a hole in that policy is a bad trade on a page that leads to charts.
 *
 * It also means no new dependency: `fetch`, `crypto`, and the two documented endpoints.
 *
 * THE ID TOKEN'S SIGNATURE IS NOT VERIFIED, deliberately. It is read from the response to
 * our own authenticated, TLS-pinned POST to Google's token endpoint — not from the browser
 * — and OpenID Connect §3.1.3.7 explicitly permits skipping signature validation for
 * tokens obtained directly from the token endpoint over TLS. Verifying it would mean
 * fetching and caching JWKS and implementing RS256, i.e. more code and a key-rotation
 * failure mode, to re-check something TLS already established.
 */

const AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** The transient cookie holding state, nonce and the PKCE verifier between the two legs. */
export const OAUTH_COOKIE = 'cliniqo_oauth';
/** Long enough for a slow consent screen, short enough that a stale tab cannot replay. */
export const OAUTH_TTL_SECONDS = 600;

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowedHostedDomain: string | undefined;
};

/**
 * The configuration, or null when the feature is not set up.
 *
 * Null is the normal case and must stay cheap to handle: every entry point checks this and
 * behaves as though the feature does not exist, rather than rendering a button that fails.
 */
export function googleConfig(): GoogleConfig | null {
  const env = getEnv();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;

  /*
   * Built from APP_URL, never from request headers. A redirect URI derived from the Host
   * header is how host-header injection turns into an authorization code delivered to an
   * attacker's domain — and Google would happily redirect there if it were registered.
   */
  const base = (env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');

  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${base}/auth/google/callback`,
    allowedHostedDomain: env.GOOGLE_ALLOWED_HD,
  };
}

export type OAuthHandshake = {
  state: string;
  nonce: string;
  codeVerifier: string;
};

const base64url = (buffer: Buffer): string => buffer.toString('base64url');

export function newHandshake(): OAuthHandshake {
  return {
    /* 256 bits each. `state` is the CSRF defence, `nonce` binds the ID token to this
       request, and the verifier is PKCE. All three are single-use. */
    state: base64url(randomBytes(32)),
    nonce: base64url(randomBytes(32)),
    codeVerifier: base64url(randomBytes(32)),
  };
}

/** S256, the only challenge method worth using — `plain` offers no protection at all. */
export function codeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

export function authorizeUrl(config: GoogleConfig, handshake: OAuthHandshake): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    /* Identity only. No Gmail, no Drive, no calendar — this application never acts on
       anyone's behalf at Google, and a scope it does not need is a scope it must not ask
       for. */
    scope: 'openid email profile',
    state: handshake.state,
    nonce: handshake.nonce,
    code_challenge: codeChallenge(handshake.codeVerifier),
    code_challenge_method: 'S256',
    /* Always show the account chooser: on a shared clinic workstation, silently reusing
       whoever signed in last is how one person's session becomes another's. */
    prompt: 'select_account',
  });

  if (config.allowedHostedDomain) {
    // A hint to Google, not a control. The `hd` claim is checked again on the way back.
    params.set('hd', config.allowedHostedDomain);
  }

  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

/** Constant-time comparison for the state echo, so it cannot be probed byte by byte. */
export function statesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export type GoogleIdentity = {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  hostedDomain: string | null;
  nonce: string | null;
};

type TokenResponse = { id_token?: string };

/**
 * Decode a JWT payload without verifying it.
 *
 * Safe ONLY because of where this token came from — see the file header. Never call this
 * on a token that arrived from a browser.
 */
function decodePayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Exchange the authorization code for an identity.
 *
 * Returns null on anything unexpected. The caller turns that into one generic failure —
 * distinguishing "bad code" from "wrong domain" from "no such account" for the person at
 * the browser would build an oracle out of the sign-in page.
 */
export async function exchangeCode(
  config: GoogleConfig,
  code: string,
  codeVerifier: string,
): Promise<GoogleIdentity | null> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) return null;

  const payload = (await response.json()) as TokenResponse;
  if (!payload.id_token) return null;

  const claims = decodePayload(payload.id_token);
  if (!claims) return null;

  const subject = typeof claims['sub'] === 'string' ? claims['sub'] : null;
  const email = typeof claims['email'] === 'string' ? claims['email'] : null;
  if (!subject || !email) return null;

  return {
    subject,
    email,
    /* Google sets this false for addresses it has not confirmed. Trusting an unverified
       address would let anyone who can create a Google account claim a staff email. */
    emailVerified: claims['email_verified'] === true,
    name: typeof claims['name'] === 'string' ? claims['name'] : null,
    hostedDomain: typeof claims['hd'] === 'string' ? claims['hd'] : null,
    nonce: typeof claims['nonce'] === 'string' ? claims['nonce'] : null,
  };
}
