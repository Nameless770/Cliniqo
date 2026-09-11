import { describe, expect, it } from 'vitest';

import {
  authorizeUrl,
  codeChallenge,
  newHandshake,
  statesMatch,
  type GoogleConfig,
} from '@/server/auth/google';

/**
 * Google sign-in: the parts that are pure.
 *
 * The route handlers are covered end to end by the e2e suite, where the CSRF and
 * link-never-create rules are asserted against a real server. This file pins the crypto
 * and URL construction, which is where a subtle mistake is both easy to make and invisible
 * in a working flow — a `plain` code challenge, a missing nonce, or a scope creeping
 * beyond identity would all still let somebody sign in successfully.
 */
const config: GoogleConfig = {
  clientId: 'test-client-id',
  clientSecret: 'test-secret',
  redirectUri: 'https://clinic.example/auth/google/callback',
  allowedHostedDomain: undefined,
};

describe('the Google authorization request', () => {
  it('uses PKCE with S256, never plain', () => {
    const handshake = newHandshake();
    const url = new URL(authorizeUrl(config, handshake));

    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    /* The challenge must be the HASH of the verifier, not the verifier — sending the
       verifier itself is `plain` by another name and protects nothing. */
    const challenge = url.searchParams.get('code_challenge');
    expect(challenge).toBe(codeChallenge(handshake.codeVerifier));
    expect(challenge).not.toBe(handshake.codeVerifier);
  });

  it('carries state and nonce, and they differ every time', () => {
    const url = new URL(authorizeUrl(config, newHandshake()));
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();

    const a = newHandshake();
    const b = newHandshake();
    // A predictable state is no CSRF defence at all.
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.state.length).toBeGreaterThanOrEqual(43); // 256 bits, base64url
  });

  it('asks only for identity scopes', () => {
    const url = new URL(authorizeUrl(config, newHandshake()));
    const scopes = (url.searchParams.get('scope') ?? '').split(' ').sort();

    /* This application never acts on anyone's behalf at Google. A scope it does not need
       is a scope it must not ask for — and one a user would be right to refuse. */
    expect(scopes).toEqual(['email', 'openid', 'profile']);
    expect(url.searchParams.get('scope')).not.toMatch(/drive|gmail|calendar|contacts/);
  });

  it('forces the account chooser', () => {
    const url = new URL(authorizeUrl(config, newHandshake()));
    /* On a shared clinic workstation, silently reusing whoever signed in last is how one
       person's session becomes another person's. */
    expect(url.searchParams.get('prompt')).toBe('select_account');
  });

  it('sends the redirect URI built from configuration, not from a request', () => {
    const url = new URL(authorizeUrl(config, newHandshake()));
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  });

  it('passes the hosted domain hint when one is configured', () => {
    const withHd = { ...config, allowedHostedDomain: 'fernbrook.example' };
    const url = new URL(authorizeUrl(withHd, newHandshake()));
    expect(url.searchParams.get('hd')).toBe('fernbrook.example');

    // And omits it entirely when not, rather than sending an empty value.
    const without = new URL(authorizeUrl(config, newHandshake()));
    expect(without.searchParams.has('hd')).toBe(false);
  });
});

describe('state comparison', () => {
  it('accepts a match and rejects everything else', () => {
    const { state } = newHandshake();
    expect(statesMatch(state, state)).toBe(true);
    expect(statesMatch(state, `${state}x`)).toBe(false);
    expect(statesMatch(state, '')).toBe(false);
    expect(statesMatch(state, state.slice(0, -1) + 'A')).toBe(false);
  });
});
