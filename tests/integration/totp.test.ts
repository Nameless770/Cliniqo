import { describe, expect, it } from 'vitest';

import {
  base32Decode,
  base32Encode,
  codeFor,
  formatForManualEntry,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  normaliseRecoveryCode,
  openSecret,
  otpauthUri,
  sealSecret,
  stepFor,
  verifyCode,
} from '@/server/auth/totp';

/**
 * TOTP, checked against the specification rather than against itself.
 *
 * This implementation is hand-written — RFC 6238 is forty lines and a dependency in the
 * login path of a PHI system is a poor trade — which puts the burden of proof here. A
 * home-grown TOTP that is subtly wrong does not fail loudly; it locks every user out on a
 * Monday morning, or worse, accepts codes it should not.
 *
 * So the first block below is the RFC's own published test vectors. Nothing else in this
 * file matters if those do not pass.
 */
describe('TOTP against RFC 6238', () => {
  /* RFC 6238 Appendix B. The SHA-1 seed is ASCII "12345678901234567890". */
  const seed = Buffer.from('12345678901234567890', 'ascii');

  /* [unix seconds, the 8-digit code the RFC publishes]. This implementation emits six
     digits — the same truncation, fewer of them — so the last six are what must match. */
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it.each(vectors)('matches the published code at T=%i', (t, expected8) => {
    expect(codeFor(seed, Math.floor(t / 30))).toBe(expected8.slice(-6));
  });

  it('encodes base32 as RFC 4648 does', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('round-trips a real secret through base32', () => {
    const secret = generateSecret();
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
    /* And tolerates what a person actually types back in. */
    expect(base32Decode(formatForManualEntry(secret).toLowerCase()).equals(secret)).toBe(
      true,
    );
  });

  it('issues 160-bit secrets, as RFC 4226 recommends for SHA-1', () => {
    expect(generateSecret()).toHaveLength(20);
  });
});

describe('verifying a code', () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;

  it('accepts the code for the current step', () => {
    const code = codeFor(secret, stepFor(now));
    expect(verifyCode(secret, code, now, null)).toEqual({ ok: true, step: stepFor(now) });
  });

  it('tolerates a phone whose clock is one step out, either way', () => {
    for (const drift of [-1, 1]) {
      const code = codeFor(secret, stepFor(now) + drift);
      expect(verifyCode(secret, code, now, null).ok).toBe(true);
    }
  });

  it('refuses a code two steps out', () => {
    const code = codeFor(secret, stepFor(now) + 2);
    expect(verifyCode(secret, code, now, null).ok).toBe(false);
  });

  it('refuses a code that has already been used', () => {
    /*
     * The property that makes this a second FACTOR rather than a second field. A code is
     * valid for thirty seconds, so without this anyone who watches it being typed — or
     * phishes it — can replay it inside the window.
     */
    const step = stepFor(now);
    const code = codeFor(secret, step);

    expect(verifyCode(secret, code, now, null)).toEqual({ ok: true, step });
    expect(verifyCode(secret, code, now, step).ok).toBe(false);
  });

  it('refuses codes from before the last one used, not just the same one', () => {
    const step = stepFor(now);
    const earlier = codeFor(secret, step - 1);
    expect(verifyCode(secret, earlier, now, step).ok).toBe(false);
  });

  it('refuses another account’s code', () => {
    const other = generateSecret();
    const code = codeFor(other, stepFor(now));
    expect(verifyCode(secret, code, now, null).ok).toBe(false);
  });

  it('refuses malformed input without throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56 78']) {
      expect(verifyCode(secret, bad, now, null).ok).toBe(false);
    }
  });

  it('accepts a code typed with a space in it', () => {
    const code = codeFor(secret, stepFor(now));
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyCode(secret, spaced, now, null).ok).toBe(true);
  });
});

describe('the secret at rest', () => {
  const sessionSecret = 'a-test-session-secret-at-least-32-characters-long';

  it('round-trips through sealing', () => {
    const secret = generateSecret();
    const sealed = sealSecret(secret, sessionSecret);

    expect(sealed).not.toContain(base32Encode(secret));
    expect(openSecret(sealed, sessionSecret)?.equals(secret)).toBe(true);
  });

  it('produces a different ciphertext every time, for the same secret', () => {
    const secret = generateSecret();
    /* A deterministic ciphertext would let anyone with the column tell which two accounts
       share a secret — and would be a reused IV, which is how GCM fails catastrophically. */
    expect(sealSecret(secret, sessionSecret)).not.toBe(sealSecret(secret, sessionSecret));
  });

  it('refuses to open under a different session secret', () => {
    const sealed = sealSecret(generateSecret(), sessionSecret);
    expect(
      openSecret(sealed, 'a-different-session-secret-also-32-chars-long'),
    ).toBeNull();
  });

  it('refuses to open a row that has been tampered with', () => {
    const sealed = sealSecret(generateSecret(), sessionSecret);
    const [iv, tag, ciphertext] = sealed.split('.') as [string, string, string];

    /* The authentication tag is the point: a modified secret must fail to open rather than
       decrypt to garbage that silently never matches a code — which would look like a
       broken phone and send the user to re-enroll instead of raising an alarm.
     *
     * Flip a bit in the ciphertext BYTES, not in a base64url character. A 20-byte
     * ciphertext encodes to 27 characters, and the last one carries only four
     * significant bits — the low two are spare — so an encoder emits one of just
     * sixteen characters there, 'A' among them. The old swap replaced a trailing 'A'
     * with 'B', which differs only in those spare bits: the string changed, the decoded
     * bytes did not, GCM verified happily, and this test failed on a correct answer
     * once every sixteen runs. It is the same trap documented in google-auth.test.ts,
     * and CI caught it here. */
    const tampered = Buffer.from(ciphertext, 'base64url');
    tampered[0] = tampered[0]! ^ 0x01;
    const flipped = `${iv}.${tag}.${tampered.toString('base64url')}`;

    expect(openSecret(flipped, sessionSecret)).toBeNull();
  });

  it('returns null for a malformed column rather than throwing', () => {
    for (const bad of ['', 'not-sealed', 'a.b', 'a.b.c.d']) {
      expect(openSecret(bad, sessionSecret)).toBeNull();
    }
  });
});

describe('recovery codes', () => {
  const sessionSecret = 'a-test-session-secret-at-least-32-characters-long';

  it('issues ten distinct codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
  });

  it('avoids the characters people misread', () => {
    /* No I, L, O or U: a code read off paper must not have two plausible transcriptions. */
    for (const code of generateRecoveryCodes()) {
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    }
  });

  it('hashes to the same value however the code is typed', () => {
    const [code] = generateRecoveryCodes(1) as [string];
    const canonical = hashRecoveryCode(code, sessionSecret);

    expect(hashRecoveryCode(code.toLowerCase(), sessionSecret)).toBe(canonical);
    expect(hashRecoveryCode(code.replace('-', ''), sessionSecret)).toBe(canonical);
    expect(hashRecoveryCode(` ${code} `, sessionSecret)).toBe(canonical);
  });

  it('does not store anything the code can be read back from', () => {
    const [code] = generateRecoveryCodes(1) as [string];
    const hash = hashRecoveryCode(code, sessionSecret);
    expect(hash).not.toContain(normaliseRecoveryCode(code));
  });

  it('hashes differently under a different session secret', () => {
    const [code] = generateRecoveryCodes(1) as [string];
    expect(hashRecoveryCode(code, sessionSecret)).not.toBe(
      hashRecoveryCode(code, 'a-different-session-secret-also-32-chars-long'),
    );
  });
});

describe('the enrollment URI', () => {
  it('carries what an authenticator app needs, and nothing clinical', () => {
    const secret = generateSecret();
    const uri = otpauthUri(secret, 'doctor@clinic.example', 'Cliniqo');

    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain(`secret=${base32Encode(secret)}`);
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    /* An email address and a clinic name is the whole disclosure to whichever app the
       user chose. No patient, no health information. */
    expect(uri).toContain(encodeURIComponent('Cliniqo:doctor@clinic.example'));
  });
});
