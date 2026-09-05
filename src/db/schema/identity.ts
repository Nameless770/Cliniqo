/**
 * Staff identity, roles, permissions, and sessions.
 *
 * Not PHI — but `password_hash` and `session.token_hash` are secrets and must never
 * leave the server or appear in logs.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  inet,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { clinic } from './clinic';
import { roleCode, sessionRevokedReason, userStatus } from './enums';
import { citext, primaryId, rowVersion, softDelete, timestamps } from './shared';

/* -------------------------------------------------------------------------- */
/* Roles and permissions — global reference data                              */
/* -------------------------------------------------------------------------- */

export const role = pgTable('role', {
  id: primaryId(),
  code: roleCode('code').notNull().unique(),
  displayName: text('display_name').notNull(),
  description: text('description'),
  ...timestamps(),
});

/**
 * Capabilities, e.g. `patient.read.identifying`, `patient.read.clinical`, `note.sign`.
 *
 * Authorization checks name permissions, never roles. The indirection costs two small
 * seeded tables and buys the ability to add a nurse role later without re-auditing every
 * access check in the codebase.
 */
export const permission = pgTable('permission', {
  id: primaryId(),
  code: text('code').notNull().unique(),
  description: text('description'),
  ...timestamps(),
});

export const rolePermission = pgTable(
  'role_permission',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => role.id),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permission.id),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.permissionId] }),
    index('role_permission_permission_idx').on(t.permissionId),
  ],
);

/* -------------------------------------------------------------------------- */
/* User accounts                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One row per human. No shared accounts — §164.312(a)(2)(i).
 */
export const userAccount = pgTable(
  'user_account',
  {
    id: primaryId(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinic.id),

    email: citext('email').notNull(),

    /**
     * Encoded password hash, self-describing: `scrypt$N$r$p$salt$hash`.
     *
     * The algorithm and its cost parameters live inside the string, so hardening the
     * parameters — or migrating to Argon2id — needs no schema change: old hashes stay
     * verifiable and are silently re-hashed on the owner's next successful login.
     */
    passwordHash: text('password_hash').notNull(),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),

    /** Set when an administrator issues a reset. There is no self-service reset path. */
    mustChangePassword: boolean('must_change_password').notNull().default(false),

    fullName: text('full_name').notNull(),

    status: userStatus('status').notNull().default('active'),

    /** Per-account lockout. Per-IP limiting lives in `auth_attempt`; both are needed. */
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),

    createdBy: uuid('created_by').references((): AnyPgColumn => userAccount.id),

    ...timestamps(),
    ...rowVersion(),
    ...softDelete((): AnyPgColumn => userAccount.id),
  },
  (t) => [
    /**
     * GLOBAL, not per-clinic.
     *
     * Login is `email + password` with no clinic selector, so the address has to resolve
     * to exactly one account. Scoping this to (clinic_id, email) would let two clinics
     * hold the same address and make the lookup ambiguous — which resolves either by
     * asking the user which clinic they belong to (leaking that an address exists
     * somewhere) or by picking one, which is worse.
     *
     * Partial, so an archived account does not permanently reserve an address. Contrast
     * with `patient.mrn`, whose uniqueness deliberately spans archived rows.
     */
    uniqueIndex('user_account_email_live_idx')
      .on(t.email)
      .where(sql`${t.archivedAt} is null`),
    index('user_account_clinic_status_idx').on(t.clinicId, t.status),
  ],
);

/**
 * Role grants. Revocations are retained rather than deleted — "this person held admin
 * between March and July" is exactly the kind of question an audit asks.
 */
export const userRole = pgTable(
  'user_role',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id),
    roleId: uuid('role_id')
      .notNull()
      .references(() => role.id),

    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    grantedBy: uuid('granted_by').references(() => userAccount.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => userAccount.id),
  },
  (t) => [
    uniqueIndex('user_role_live_idx')
      .on(t.userId, t.roleId)
      .where(sql`${t.revokedAt} is null`),
    /** Read on every authenticated request — permissions resolve from live state. */
    index('user_role_user_live_idx')
      .on(t.userId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

/**
 * Clinician-specific attributes. 1—0..1 with user_account.
 *
 * No DEA number: controlled-substance prescribing is out of scope, and storing a DEA
 * number for a capability the system does not offer is liability without benefit.
 */
export const providerProfile = pgTable('provider_profile', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => userAccount.id),

  npi: text('npi'),
  licenseNumber: text('license_number'),
  licenseState: text('license_state'),
  licenseExpiresOn: date('license_expires_on'),
  specialty: text('specialty'),

  canPrescribe: boolean('can_prescribe').notNull().default(true),
  defaultAppointmentDurationMinutes: integer('default_appointment_duration_minutes')
    .notNull()
    .default(20),

  ...timestamps(),
});

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Sessions carry identity only — never permissions.
 *
 * Permissions resolve from `user_role` on every request, so a role change or a
 * deactivation takes effect on the next request rather than whenever the token
 * happens to expire.
 */
export const session = pgTable(
  'session',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id),

    /**
     * SHA-256 of the session token. The raw token is never stored, so a database read —
     * a leaked backup, a compromised replica — does not yield usable sessions.
     */
    tokenHash: text('token_hash').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),

    /** Automatic logoff — §164.312(a)(2)(iii). Slides forward on activity. */
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    /** Independent ceiling. Does not slide. */
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),

    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),

    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: sessionRevokedReason('revoked_reason'),
  },
  (t) => [
    uniqueIndex('session_token_hash_idx').on(t.tokenHash),
    /** Makes "deactivate this user and kill their live sessions now" a single cheap statement. */
    index('session_user_live_idx')
      .on(t.userId)
      .where(sql`${t.revokedAt} is null`),
    index('session_absolute_expiry_idx').on(t.absoluteExpiresAt),
  ],
);

/**
 * Login attempts, for rate limiting and lockout.
 *
 * This is operational security telemetry, not an audit record: it holds no PHI, and it
 * is retained ~90 days rather than six years. Keeping it out of `audit_event` stops
 * brute-force noise from swamping the compliance log.
 */
export const authAttempt = pgTable(
  'auth_attempt',
  {
    id: primaryId(),
    clinicId: uuid('clinic_id').references(() => clinic.id),
    /** Recorded even when no account matches — that is the signal worth having. */
    emailAttempted: citext('email_attempted').notNull(),
    userId: uuid('user_id').references(() => userAccount.id),
    ipAddress: inet('ip_address'),
    succeeded: boolean('succeeded').notNull(),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * Two indexes, because rate limiting must be per-account AND per-IP at once.
     * Per-IP alone misses distributed credential stuffing; per-account alone lets a
     * single host spray many accounts.
     */
    index('auth_attempt_email_time_idx').on(t.emailAttempted, t.attemptedAt.desc()),
    index('auth_attempt_ip_time_idx').on(t.ipAddress, t.attemptedAt.desc()),
  ],
);
