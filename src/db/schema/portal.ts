/**
 * Patient portal identity — accounts, sessions, and invite tokens for patients.
 *
 * DELIBERATELY SEPARATE from staff identity (identity.ts). A patient is not a scaled-down
 * staff member: they have no role, no permission grants, and exactly one capability —
 * acting on their own record. Keeping the two identity systems in different tables, with
 * different sessions and different cookies, means a defect in one cannot escalate into the
 * other. `password_hash` and `token_hash` here are secrets and must never leave the server
 * or appear in a log.
 */

import { sql } from 'drizzle-orm';
import {
  inet,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { clinic } from './clinic';
import { userStatus } from './enums';
import { userAccount } from './identity';
import { patient } from './patient';
import { citext, primaryId, softDelete, timestamps } from './shared';

/**
 * A patient's login. One account per patient (`patient_id` is unique among live rows), and
 * one patient per account. Created only by staff invitation — there is no public signup,
 * so a stranger cannot probe which emails are registered.
 */
export const patientAccount = pgTable(
  'patient_account',
  {
    id: primaryId(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinic.id),
    /** The one record this login may ever see or act on. */
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patient.id),

    email: citext('email').notNull(),
    /** Same self-describing scrypt encoding as staff — see user_account.password_hash. */
    passwordHash: text('password_hash').notNull(),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),

    status: userStatus('status').notNull().default('active'),

    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),

    /** The staff member who issued the invitation. */
    createdBy: uuid('created_by'),

    ...timestamps(),
    ...softDelete(() => userAccount.id),
  },
  (t) => [
    /*
     * Global among live accounts, same reasoning as staff: login is email + password with
     * no clinic selector, so the address must resolve to exactly one account.
     */
    uniqueIndex('patient_account_email_live_idx')
      .on(t.email)
      .where(sql`${t.archivedAt} is null`),
    /* One live portal account per patient. */
    uniqueIndex('patient_account_patient_live_idx')
      .on(t.patientId)
      .where(sql`${t.archivedAt} is null`),
    index('patient_account_clinic_idx').on(t.clinicId),
  ],
);

/**
 * Patient portal sessions. Same opaque-token-stored-as-SHA-256 design as staff sessions,
 * in its own table and behind its own cookie so the two session systems never intersect.
 */
export const patientSession = pgTable(
  'patient_session',
  {
    id: primaryId(),
    patientAccountId: uuid('patient_account_id')
      .notNull()
      .references(() => patientAccount.id),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    userAgent: text('user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('patient_session_token_idx').on(t.tokenHash),
    index('patient_session_account_idx').on(t.patientAccountId),
  ],
);

/**
 * Single-use invitation token. A staff member generates one; the raw token is shown once
 * and the patient redeems it at /portal/claim to set their password. Only the SHA-256 is
 * stored, so a database read yields nothing usable — identical to staff_setup_token.
 */
export const patientSetupToken = pgTable(
  'patient_setup_token',
  {
    id: primaryId(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinic.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patient.id),
    /** Present once the account exists; null while the very first invite is outstanding. */
    patientAccountId: uuid('patient_account_id').references(() => patientAccount.id),

    tokenHash: text('token_hash').notNull(),
    email: citext('email').notNull(),

    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    usedAt: timestamp('used_at', { withTimezone: true }),
    usedIp: inet('used_ip'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('patient_setup_token_hash_idx').on(t.tokenHash),
    /* At most one live invite per patient. */
    uniqueIndex('patient_setup_token_live_idx')
      .on(t.patientId)
      .where(sql`${t.usedAt} is null and ${t.revokedAt} is null`),
  ],
);
