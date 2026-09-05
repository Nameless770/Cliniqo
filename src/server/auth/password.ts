import 'server-only';

import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { promisify } from 'node:util';

/*
 * promisify() infers scrypt's 3-argument overload, which drops the options parameter —
 * and the options are where the cost parameters live. Asserted to the 4-argument form.
 */
const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Password hashing — scrypt, from node:crypto.
 *
 * WHY NOT ARGON2ID. OWASP puts Argon2id first and scrypt second; both are memory-hard
 * and both are acceptable. Argon2 in Node means a native-binding dependency, and
 * CLAUDE.md requires flagging a new dependency rather than reaching for one. scrypt ships
 * with the runtime, so the supply chain for the single most security-critical function in
 * the application is "Node itself". If you want Argon2id, say so — the encoded format
 * below already carries an algorithm tag, so migrating is a rehash-on-login, not a
 * migration.
 *
 * PARAMETERS. OWASP's headline scrypt figure is N=2^17, r=8, p=1, which costs
 * 128 * N * r ≈ 134 MB of RAM per hash. That number is per concurrent hash: fifteen staff
 * badging in at 08:00 is 2 GB and a saturated box, which turns the login page into its own
 * denial-of-service vector. N=2^16 with p=3 halves peak memory to ~67 MB while keeping
 * comparable total work. Raise N if you deploy somewhere with room — old hashes keep
 * verifying, because the parameters travel inside the encoded string.
 */
const ALGORITHM = 'scrypt';
const N = 65536; // 2^16 — CPU/memory cost
const R = 8; // block size
const P = 3; // parallelisation
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/** node:crypto caps scrypt memory at 32 MB by default, well below what N=2^16 needs. */
const MAX_MEM = 128 * N * R * 2;

/** `scrypt$N$r$p$salt$hash` — self-describing, so parameters can change over time. */
function encode(salt: Buffer, derived: Buffer): string {
  return [ALGORITHM, N, R, P, salt.toString('base64'), derived.toString('base64')].join(
    '$',
  );
}

type Parsed = { n: number; r: number; p: number; salt: Buffer; hash: Buffer };

function parse(encoded: string): Parsed | null {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return null;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return null;

  try {
    return {
      n,
      r,
      p,
      salt: Buffer.from(parts[4]!, 'base64'),
      hash: Buffer.from(parts[5]!, 'base64'),
    };
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEM,
  });

  return encode(salt, derived);
}

/**
 * Verify a password against an encoded hash.
 *
 * Compared with `timingSafeEqual`, not `===`. A byte-by-byte early-exit comparison leaks
 * how many leading bytes matched, which is enough to reconstruct a hash over many
 * requests.
 *
 * Returns false rather than throwing on a malformed stored hash: an unreadable hash is a
 * failed login, never a 500 that tells an attacker something went differently.
 */
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const parsed = parse(encoded);
  if (!parsed) return false;

  try {
    const derived = await scrypt(
      password.normalize('NFKC'),
      parsed.salt,
      parsed.hash.length,
      {
        N: parsed.n,
        r: parsed.r,
        p: parsed.p,
        maxmem: 128 * parsed.n * parsed.r * 2,
      },
    );

    if (derived.length !== parsed.hash.length) return false;
    return timingSafeEqual(derived, parsed.hash);
  } catch {
    return false;
  }
}

/** True when a stored hash used weaker parameters than the current policy. */
export function needsRehash(encoded: string): boolean {
  const parsed = parse(encoded);
  if (!parsed) return true;
  return parsed.n < N || parsed.r < R || parsed.p < P;
}

/**
 * A real hash of a value nobody holds, used to equalise timing.
 *
 * When an email does not exist there is nothing to verify against, and returning
 * immediately makes "no such account" measurably faster than "wrong password" — which
 * turns the login form into an account-enumeration oracle. The login path verifies
 * against this instead, so both branches pay the same cost.
 *
 * Computed once, lazily, so process start does not pay for it.
 */
let dummyHash: Promise<string> | undefined;

export function decoyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64'));
  return dummyHash;
}
