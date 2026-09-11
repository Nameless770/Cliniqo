/**
 * Clinic and clinic configuration.
 *
 * The clinic is the covered entity, not a patient — nothing in this module is PHI.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  time,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from './shared';

/* -------------------------------------------------------------------------- */

export const clinic = pgTable('clinic', {
  id: primaryId(),

  name: text('name').notNull(),

  /**
   * IANA timezone (e.g. "America/New_York"). Every timestamp in the database is UTC;
   * this is what they are rendered in. Stored per clinic rather than assumed from the
   * server, because the server's timezone is an accident of deployment.
   */
  timezone: text('timezone').notNull(),

  /** Clinic-level National Provider Identifier. */
  npi: text('npi'),

  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  city: text('city'),
  state: text('state'),
  postalCode: text('postal_code'),
  phone: text('phone'),

  /** Prefix and counter for issuing medical record numbers. */
  mrnPrefix: text('mrn_prefix').notNull().default('MRN'),

  /**
   * ISO 4217, for billing. Stored per clinic rather than assumed, for the same reason as
   * the timezone above: the currency is a property of the practice, not of the server.
   * Copied onto each invoice at creation so changing it never re-denominates history.
   */
  currency: text('currency').notNull().default('USD'),
  mrnSequence: integer('mrn_sequence').notNull().default(1),

  ...timestamps(),

  // Deliberately no soft-delete actor FK here: user_account references clinic, so a
  // clinic-level archived_by would create an avoidable module cycle. Clinics are not
  // archived in the MVP.
});

/* -------------------------------------------------------------------------- */

/**
 * Weekly opening hours.
 *
 * Multiple rows per weekday are allowed on purpose — that is how split shifts and lunch
 * closures are represented. So there is no unique constraint on (clinic, day).
 */
export const clinicHours = pgTable(
  'clinic_hours',
  {
    id: primaryId(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinic.id),

    /** 0 = Sunday … 6 = Saturday, matching PostgreSQL's `extract(dow from ...)`. */
    dayOfWeek: smallint('day_of_week').notNull(),

    opensAt: time('opens_at').notNull(),
    closesAt: time('closes_at').notNull(),

    ...timestamps(),
  },
  (t) => [
    index('clinic_hours_clinic_day_idx').on(t.clinicId, t.dayOfWeek),
    check('clinic_hours_day_range', sql`${t.dayOfWeek} between 0 and 6`),
    check('clinic_hours_time_order', sql`${t.closesAt} > ${t.opensAt}`),
  ],
);
