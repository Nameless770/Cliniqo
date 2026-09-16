import { describe, expect, it } from 'vitest';

import { signToken, verifyToken } from '@/lib/signed-token';

/**
 * The token that carries a Google-verified identity to the sign-up form.
 *
 * If it could be edited, a visitor could claim someone else's email and Google subject and
 * create an account under them. Every way of getting it wrong must come back as null.
 */
const SECRET = 'test-secret-that-is-at-least-thirty-two-chars';
const PURPOSE = 'pending-signup';
const NOW = 1_800_000_000_000;

const mint = (overrides: Record<string, unknown> = {}) =>
  signToken(
    {
      aud: 'portal',
      sub: 'google-sub',
      email: 'someone@example.invalid',
      exp: NOW + 60_000,
      ...overrides,
    },
    SECRET,
    PURPOSE,
  );

describe('signed sign-up tokens', () => {
  it('round-trips a valid token', () => {
    const payload = verifyToken(mint(), SECRET, PURPOSE, NOW);
    expect(payload?.['email']).toBe('someone@example.invalid');
    expect(payload?.['aud']).toBe('portal');
  });

  it('refuses a token whose contents were edited', () => {
    const [body, signature] = mint().split('.') as [string, string];
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    decoded.email = 'victim@example.invalid';
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;

    /* The attack this exists to stop: keep a valid signature, swap in another address. */
    expect(verifyToken(forged, SECRET, PURPOSE, NOW)).toBeNull();
  });

  it('refuses a token with an altered signature', () => {
    const token = mint();
    const [body, signature] = token.split('.') as [string, string];

    /*
     * Flip a bit in the signature BYTES. Substituting the last base64url character does
     * not reliably change them: 32 bytes encode to 43 characters, and the last one holds
     * only four significant bits, so an encoder emits one of just sixteen characters
     * there. When that character was 'A' the old 'A'-to-'B' swap left the decoded bytes
     * identical — verifyToken compares bytes with timingSafeEqual — and this test failed
     * on a correct answer once every sixteen runs. Measured at 6.2% over 50,000 tokens.
     *
     * `expect(flipped).not.toBe(token)` did not catch it: the STRING differed, which is
     * exactly what made the bug survive review.
     */
    const tampered = Buffer.from(signature, 'base64url');
    tampered[0] = tampered[0]! ^ 0x01;
    const flipped = `${body}.${tampered.toString('base64url')}`;

    expect(flipped).not.toBe(token);
    expect(verifyToken(flipped, SECRET, PURPOSE, NOW)).toBeNull();
  });

  it('refuses a token signed with a different secret', () => {
    const other = signToken(
      { aud: 'portal', sub: 's', email: 'e@example.invalid', exp: NOW + 60_000 },
      'a-completely-different-secret-of-enough-length',
      PURPOSE,
    );
    expect(verifyToken(other, SECRET, PURPOSE, NOW)).toBeNull();
  });

  it('refuses a token signed for a different purpose', () => {
    /* The key is derived per purpose, so a token minted for one use never verifies as another. */
    const other = signToken(
      { aud: 'portal', sub: 's', email: 'e@example.invalid', exp: NOW + 60_000 },
      SECRET,
      'something-else',
    );
    expect(verifyToken(other, SECRET, PURPOSE, NOW)).toBeNull();
  });

  it('refuses an expired token, and one expiring this very millisecond', () => {
    expect(verifyToken(mint({ exp: NOW - 1 }), SECRET, PURPOSE, NOW)).toBeNull();
    expect(verifyToken(mint({ exp: NOW }), SECRET, PURPOSE, NOW)).toBeNull();
  });

  it('refuses malformed input without throwing', () => {
    for (const bad of [undefined, '', 'no-dot', 'a.b.c', '.', 'bm90IGpzb24.c2ln']) {
      expect(verifyToken(bad, SECRET, PURPOSE, NOW)).toBeNull();
    }
  });
});
