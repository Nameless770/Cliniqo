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

/** The UTC offset in minutes that `timeZone` had at `instant`. */
function offsetMinutesAt(instant: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  })
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
