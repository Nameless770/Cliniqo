/**
 * Clinic-local time.
 *
 * Every instant in the database is UTC. The schedule is read by people standing in a
 * building, so it must be rendered — and its day boundaries computed — in the clinic's
 * own timezone.
 *
 * This matters more than it sounds. A day view whose boundaries are UTC midnight shows
 * the wrong appointments near either end of the day for any clinic west of Greenwich: an
 * 8pm appointment in New York is already "tomorrow" in UTC and vanishes off the day it
 * belongs to. Staff would conclude the schedule is broken, and they would be right.
 *
 * No dependency: `Intl` knows the whole tz database, including DST transitions, so the
 * offset is asked for at the specific instant rather than assumed constant.
 */

/*
 * One formatter per timezone, reused.
 *
 * Constructing an `Intl.DateTimeFormat` is the expensive part of asking for an offset —
 * it loads and binds tz data. The slot finder converts a wall clock per candidate slot,
 * which is hundreds of calls for one page, and building a formatter each time turned a
 * cheap arithmetic loop into the slowest thing on the request. A clinic has one timezone,
 * so the map holds one entry; it is keyed anyway because the type says it can vary.
 */
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = offsetFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
    offsetFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The UTC offset in minutes that `timeZone` had at `instant`. */
function offsetMinutesAt(instant: Date, timeZone: string): number {
  const name = offsetFormatter(timeZone)
    .formatToParts(instant)
    .find((p) => p.type === 'timeZoneName')?.value;

  // "GMT-05:00", or plain "GMT" at zero offset.
  const match = name?.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;

  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * The UTC instant of local midnight on `dateISO` (YYYY-MM-DD) in `timeZone`.
 *
 * Computed twice: the offset on a DST boundary differs either side of midnight, and the
 * first guess can land on the wrong side of the transition. The second pass uses the
 * offset actually in force at the candidate instant.
 */
export function zonedStartOfDay(dateISO: string, timeZone: string): Date {
  const naive = new Date(`${dateISO}T00:00:00Z`);
  const firstPass = new Date(naive.getTime() - offsetMinutesAt(naive, timeZone) * 60_000);
  return new Date(naive.getTime() - offsetMinutesAt(firstPass, timeZone) * 60_000);
}

/** Half-open [start, end) covering one clinic-local day. */
export function zonedDayRange(dateISO: string, timeZone: string): [Date, Date] {
  const start = zonedStartOfDay(dateISO, timeZone);
  const nextDay = new Date(`${dateISO}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const end = zonedStartOfDay(nextDay.toISOString().slice(0, 10), timeZone);
  return [start, end];
}

/** Half-open range covering the Monday-to-Sunday week containing `dateISO`. */
export function zonedWeekRange(dateISO: string, timeZone: string): [Date, Date] {
  const anchor = new Date(`${dateISO}T00:00:00Z`);
  // getUTCDay: 0 = Sunday. Shift so Monday starts the week.
  const shift = (anchor.getUTCDay() + 6) % 7;
  anchor.setUTCDate(anchor.getUTCDate() - shift);

  const startISO = anchor.toISOString().slice(0, 10);
  const endAnchor = new Date(anchor);
  endAnchor.setUTCDate(endAnchor.getUTCDate() + 7);

  return [
    zonedStartOfDay(startISO, timeZone),
    zonedStartOfDay(endAnchor.toISOString().slice(0, 10), timeZone),
  ];
}

/** Today, as YYYY-MM-DD in the clinic's timezone — not the server's. */
export function todayInZone(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function formatTimeInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);
}

export function formatDateInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(instant);
}

/** Shift a YYYY-MM-DD anchor by whole days, staying a calendar date. */
export function shiftDate(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The UTC instant of a WALL-CLOCK time in `timeZone`.
 *
 * The missing half of this module. Everything above renders or bounds an instant in
 * clinic time; this is the only function that goes the other way — taking what a human
 * typed into a `datetime-local` field and deciding which instant they meant.
 *
 * IT HAS TO EXIST, because `new Date('2027-03-01T09:00')` is not a neutral parse. A
 * date-time string with no offset is interpreted in the JavaScript runtime's OWN
 * timezone, so the appointment a receptionist books lands wherever the SERVER happens to
 * be configured. On a container running UTC, a New York clinic's 09:00 is stored as
 * 09:00Z and displayed back as 04:00. The clinic's timezone — the one thing that should
 * decide this — is not consulted at all.
 *
 * Two passes, for the same reason as `zonedStartOfDay`: on a DST boundary the offset
 * differs either side of the target, and a single-pass guess lands on the wrong side.
 *
 * @param localISO Wall-clock 'YYYY-MM-DDTHH:mm' (seconds optional), as a browser's
 *                 datetime-local input produces. NOT an instant — it carries no offset.
 */
export function zonedWallClock(localISO: string, timeZone: string): Date {
  const trimmed = localISO.trim();
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?/);
  if (!match) return new Date(NaN);

  // Read the wall-clock digits as if they were UTC, then subtract the real offset.
  const naive = new Date(`${match[1]}T${match[2]}:${match[3] ?? '00'}Z`);
  if (Number.isNaN(naive.getTime())) return naive;

  const firstPass = new Date(naive.getTime() - offsetMinutesAt(naive, timeZone) * 60_000);
  return new Date(naive.getTime() - offsetMinutesAt(firstPass, timeZone) * 60_000);
}

/**
 * The inverse: an instant rendered as 'YYYY-MM-DDTHH:mm' in `timeZone`.
 *
 * For pre-filling a `datetime-local` input. `toISOString().slice(0,16)` would show the
 * UTC wall clock, which is the same bug in the other direction — a reschedule form would
 * open showing a different time from the one on the schedule beside it.
 */
export function formatWallClockInZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  // en-CA renders hour 24 for midnight in some runtimes; normalise to 00.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

/**
 * One bound of a PostgreSQL range, as a Date.
 *
 * Two things stand between the text PostgreSQL emits and a spec-compliant ISO string, and
 * both were previously papered over by V8's lenient fallback parser — which no
 * specification promises and which `Date.parse` explicitly leaves implementation-defined:
 *
 *   1. The bound is QUOTED, because a timestamp contains a space.
 *   2. A whole-hour offset renders as `+00`; ISO 8601 requires `+00:00`.
 *
 * `["2027-03-01 09:00:00+00", ...)` therefore has to become `2027-03-01T09:00:00+00:00`
 * before `new Date` will parse it by the rules rather than by good luck. Every appointment
 * time shown to a patient depends on this, so it is done explicitly.
 */
function rangeBound(raw: string): Date {
  const unquoted = raw.replace(/^"|"$/g, '').replace(' ', 'T');
  return new Date(unquoted.replace(/([+-]\d{2})$/, '$1:00'));
}

/** The two instants of a PostgreSQL `tstzrange` in its text form. */
export function parseTstzRange(during: string): [Date, Date] {
  const match = /^\[(.+),(.+)\)$/.exec(during);
  if (!match) return [new Date(NaN), new Date(NaN)];
  return [rangeBound(match[1]!), rangeBound(match[2]!)];
}
