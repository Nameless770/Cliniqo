/**
 * Shared column types and reusable column groups.
 *
 * Everything here is used across more than one domain module. Nothing in this file
 * imports a domain module, so it can never participate in an import cycle — domain
 * modules pass their own table references in as callbacks where a foreign key is needed.
 */

import { sql } from 'drizzle-orm';
import {
  customType,
  integer,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/* -------------------------------------------------------------------------- */
/* Custom column types                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Case-insensitive text. Requires the `citext` extension.
 *
 * Used for login identifiers and patient email. Storing these as plain `text` would
 * mean every lookup needs `lower(...)`, and the first place someone forgets is the
 * place a duplicate account or duplicate chart gets created.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});

/**
 * `tstzrange` — a timezone-aware time range.
 *
 * This exists so appointments can carry a real range column, which is what makes the
 * GiST exclusion constraint possible. Preventing concurrent double-booking is not
 * achievable in application code: two requests both read "slot free" before either
 * writes. See migration 0001.
 *
 * Represented as a string in TypeScript (`["2026-09-05 09:00+00","2026-09-05 09:30+00")`).
 * The scheduling layer wraps construction so callers never build these by hand.
 */
export const tstzrange = customType<{ data: string; driverData: string }>({
  dataType: () => 'tstzrange',
});

/** Full-text search vector. Generated column — never written directly. */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

/* -------------------------------------------------------------------------- */
/* Reusable column groups                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Primary key.
 *
 * Defaults to `gen_random_uuid()` (v4), available on PostgreSQL 13+ without an
 * extension, so the schema stays portable across managed providers.
 *
 * `audit_event` is the exception: the application supplies a UUIDv7 explicitly, because
 * v4 keys scatter inserts across the whole B-tree and that table takes a write on every
 * PHI read. See the note in audit.ts.
 */
export const primaryId = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);

export const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Soft delete. There are no hard deletes of clinical data anywhere in this schema.
 *
 * `archived_at IS NULL` means the row is live. Note that partial unique indexes must be
 * scoped to live rows wherever a value should become reusable after archival — and must
 * NOT be, where the value identifies a record that still exists (see `patient.mrn`).
 */
export const softDelete = (actorRef: () => AnyPgColumn) => ({
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  archivedBy: uuid('archived_by').references(actorRef),
  archiveReason: text('archive_reason'),
});

/**
 * Optimistic concurrency token.
 *
 * Present on every table two users can edit at the same time. The write path checks the
 * caller's copy against the stored value and raises a conflict rather than silently
 * discarding the other author's work — which is the failure mode that matters for
 * clinical notes.
 */
export const rowVersion = () => ({
  version: integer('version').notNull().default(1),
});
