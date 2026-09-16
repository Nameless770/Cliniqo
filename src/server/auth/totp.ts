import 'server-only';

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Time-based one-time passwords — RFC 6238, and the crypto around them.
 *
 * ==========================================================================
 * NO DEPENDENCY, DELIBERATELY
 * ==========================================================================
 *
 * TOTP is an HMAC over a counter and a truncation rule. The whole of RFC 6238 is the forty
 * lines below, and `node:crypto` already ships everything it needs. CLAUDE.md asks before a
 * library is added, and a package in the authentication path of a system holding PHI is one
 * whose entire dependency tree becomes part of the login boundary — the same reasoning that
 * kept the Google sign-in flow to `fetch` and two documented endpoints.
 *
 * What this does NOT include is a QR encoder, which is a genuinely large amount of code
 * (Reed–Solomon, masking, version selection) and the one place a dependency would earn its
 * place. Enrollment shows the secret for manual entry instead, which every authenticator
 * app supports. Worth revisiting as a deliberate ask.
 *
 * ==========================================================================
 * THE SECRET IS A CREDENTIAL AND IS ENCRYPTED AT REST
 * ==========================================================================
 *
 * A TOTP secret in a database dump is a permanent second factor for everyone in it. Stored
 * as AES-256-GCM, keyed by HKDF-style derivation from `SESSION_SECRET` with its own purpose
 * string — the same construction `lib/signed-token.ts` already uses, so a key minted for
 * one purpose cannot verify another.
 *
 * THE TRADE-OFF, STATED: rotating `SESSION_SECRET` makes every enrollment undecryptable and
 * everyone must re-enroll. That is worse than the re-login that rotation already causes.
 * The alternative — a dedicated key — is one more piece of required configuration and one
 * more thing to lose, and can be introduced later behind a re-encryption migration. This
 * is the choice to revisit first if key rotation ever becomes routine.
 */

/* -------------------------------------------------------------------------- */
/* Base32 — RFC 4648, unpadded, which is what authenticator apps read.        */
/* -------------------------------------------------------------------------- */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  /* Tolerant of what a person types: spaces, lower case, and the padding some apps show. */
  const clean = input.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* -------------------------------------------------------------------------- */
/* The algorithm                                                              */
/* -------------------------------------------------------------------------- */

/** 30 seconds. Every authenticator app assumes it; it is not a knob. */
export const STEP_SECONDS = 30;
const DIGITS = 6;

/**
 * 160 bits, which is RFC 4226's recommendation for HMAC-SHA1 and what every app expects.
 * Not shortened to make the manual-entry string prettier — that string is typed once.
 */
export function generateSecret(): Buffer {
  return randomBytes(20);
}

/** The counter for an instant. Exported so tests can drive time instead of waiting. */
export function stepFor(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/**
 * One code for one counter — RFC 6238 §4, RFC 4226 §5.3 dynamic truncation.
 *
 * SHA-1 is correct here and is not a weakness: HOTP's security rests on HMAC, for which
 * SHA-1 remains sound, and every authenticator app in existence speaks SHA-1. Using
 * SHA-256 would produce codes nobody's phone could generate.
 */
export function codeFor(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export type TotpVerdict = { ok: true; step: number } | { ok: false };

/**
 * Check a code, and say WHICH counter it matched.
 *
 * The caller stores that counter and refuses anything at or below it next time. Without
 * that, a code is valid for its whole 30-second window and anyone who watches it being
 * typed — or reads it out of a phishing page — can replay it immediately. A second factor
 * that survives being observed is not one.
 *
 * ±1 step of tolerance, so a phone whose clock is half a minute out still works. Wider
 * windows multiply the guessing surface for no real usability gain.
 *
 * Constant-time comparison: a 6-digit code is small enough that a timing oracle on the
 * comparison is not a theoretical concern.
 */
export function verifyCode(
  secret: Buffer,
  code: string,
  nowMs: number,
  lastUsedStep: number | null,
): TotpVerdict {
  const trimmed = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(trimmed)) return { ok: false };

  const current = stepFor(nowMs);

  for (const step of [current - 1, current, current + 1]) {
    /* Replay: a counter already spent is spent, including the ones behind it. */
    if (lastUsedStep !== null && step <= lastUsedStep) continue;

    const expected = Buffer.from(codeFor(secret, step));
    const given = Buffer.from(trimmed);
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      return { ok: true, step };
    }
  }
  return { ok: false };
}

/**
 * The enrollment URI an authenticator app consumes.
 *
 * The label carries the account's email, so somebody with several accounts can tell them
 * apart in the app. That is a disclosure to whatever app they chose — an email address and
 * a clinic name, no health information — and is unavoidable if the entry is to be usable.
 */
export function otpauthUri(secret: Buffer, email: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Grouped into fours, because the alternative is a 32-character run typed by hand. */
export function formatForManualEntry(secret: Buffer): string {
  return base32Encode(secret)
    .replace(/(.{4})/g, '$1 ')
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Encryption at rest                                                         */
/* -------------------------------------------------------------------------- */

const ENCRYPTION_PURPOSE = 'cliniqo:totp-secret:v1';

function encryptionKey(sessionSecret: string): Buffer {
  return createHmac('sha256', sessionSecret).update(ENCRYPTION_PURPOSE).digest();
}

/**
 * `iv.tag.ciphertext`, base64url, one column.
 *
 * GCM rather than CBC: the tag means a secret altered in the database fails to open rather
 * than decrypting to something that quietly never matches a code, which would look like a
 * broken phone and send the user to re-enroll instead of raising an alarm.
 */
export function sealSecret(secret: Buffer, sessionSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(sessionSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return [
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** Null for anything that does not open: wrong key, altered row, malformed column. */
export function openSecret(sealed: string, sessionSecret: string): Buffer | null {
  const parts = sealed.split('.');
  if (parts.length !== 3) return null;

  try {
    const [iv, tag, ciphertext] = parts as [string, string, string];
    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey(sessionSecret),
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Recovery codes                                                             */
/* -------------------------------------------------------------------------- */

export const RECOVERY_CODE_COUNT = 10;

/**
 * Losing a phone must not mean losing the account.
 *
 * Without these the recovery path is "ring an administrator", which in a small clinic is
 * often the same person who is locked out — and an urgent lockout is exactly the pressure
 * that gets 2FA switched off for everybody.
 *
 * Crockford-ish alphabet: no I, L, O, U, so a code read off paper cannot be mistyped into
 * a different valid-looking one. 40 bits each, which is not password-grade but is
 * single-use, rate limited, and one of ten.
 */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(8);
    let code = '';
    for (let j = 0; j < 8; j++) code += RECOVERY_ALPHABET[bytes[j]! % 32];
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return codes;
}

/** Normalised so that case and the dash do not decide whether recovery works. */
export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * Recovery codes are hashed, not encrypted.
 *
 * They are verified by comparison and never need reading back, so there is nothing to gain
 * from reversibility and a great deal to lose. SHA-256 rather than scrypt: unlike a
 * password these are 40 bits of full-entropy random, so there is no dictionary to run and
 * no user-chosen weakness to stretch away from.
 */
export function hashRecoveryCode(code: string, sessionSecret: string): string {
  return createHmac('sha256', encryptionKey(sessionSecret))
    .update(normaliseRecoveryCode(code))
    .digest('base64url');
}
