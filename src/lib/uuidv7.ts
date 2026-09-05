import { randomFillSync } from 'node:crypto';

/**
 * UUIDv7 — time-ordered, RFC 9562.
 *
 * Layout: 48-bit big-endian Unix milliseconds, 4-bit version (7), 12 bits random,
 * 2-bit variant (0b10), 62 bits random.
 *
 * Used for `audit_event.id`. That table takes a write on every PHI read and is the
 * highest-insert table in the system; v4 keys scatter those inserts across the whole
 * B-tree, while v7 keeps them at the right-hand edge where the pages are already hot.
 *
 * Hand-rolled rather than pulled from npm: it is fifteen lines against `node:crypto`, and
 * every dependency in a PHI application is supply-chain surface that has to be justified.
 */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  randomFillSync(bytes);

  const ms = Date.now();

  // 48-bit timestamp, big-endian.
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;

  // Version 7 in the high nibble of byte 6; low nibble stays random.
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  // Variant 0b10 in the top two bits of byte 8.
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
