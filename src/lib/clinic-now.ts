/**
 * What "now" means for a clinic.
 *
 * Two answers the interface states out loud — "Open now" on the portal, and the Now line on
 * the schedule — and both are claims about the world that a patient or a receptionist may
 * act on. They live here as pure functions of an injected instant, rather than inline in a
 * component reading the system clock, so they can be tested at 23:59 in Los Angeles and on
 * a bank holiday without waiting for either.
 *
 * No `server-only`: the portal's clock island runs `isClinicOpen` in the browser, and
 * nothing in this file touches patient data — hours, closures, and instants.
 */

export type WeeklyHours = { dayOfWeek: number; opensAt: string; closesAt: string };
export type Closure = { startsAt: string; endsAt: string };

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/*
 * YYYY-MM-DD in the clinic's zone, for comparing calendar days. Not `formatDateInZone`,
 * which renders "Sun 13 Sep" for people and carries no year — two instants a year apart
 * would compare as the same day.
 */
const dayKey = (instant: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);

/** The clinic's wall clock at an instant, read in the clinic's zone, never the reader's. */
export function clinicWallClock(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';

  const weekdayShort = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).format(instant);

  return {
    /* Built from parts: en-GB's own pattern inserts a comma the design study does not. */
    date: `${get('weekday')} ${get('day')} ${get('month')} ${get('year')}`,
    hms: `${get('hour')}:${get('minute')}:${get('second')}`,
    hm: `${get('hour')}:${get('minute')}`,
    /** 0 = Sunday, matching `clinic_hours.day_of_week`. */
    dayOfWeek: WEEKDAYS.indexOf(weekdayShort),
  };
}

/**
 * Open is two questions and both must say yes: is it inside today's hours, and is it
 * outside every closure. The weekly timetable alone would announce "Open now" on a bank
 * holiday, to a patient who might simply turn up.
 *
 * "Today" is the CLINIC's today. A patient reading the portal from another zone, or a
 * clinic west of Greenwich in its evening, must not be judged against the UTC weekday.
 */
export function isClinicOpen(
  instant: Date,
  timeZone: string,
  hours: readonly WeeklyHours[],
  closures: readonly Closure[],
): boolean {
  const wall = clinicWallClock(instant, timeZone);

  /* `clinic_hours` stores HH:MM:SS, and zero-padded clock strings order lexically. */
  const withinHours = hours.some(
    (h) =>
      h.dayOfWeek === wall.dayOfWeek && h.opensAt <= wall.hms && wall.hms < h.closesAt,
  );
  if (!withinHours) return false;

  const t = instant.getTime();
  return !closures.some(
    (c) => new Date(c.startsAt).getTime() <= t && t < new Date(c.endsAt).getTime(),
  );
}

/**
 * The appointment the schedule's Now line sits above: the earliest one that starts later
 * today, in the clinic's zone.
 *
 * Undefined when every appointment today has already begun — there is no gap left to mark,
 * and a line drawn after the last row would claim a position the diary does not have. Takes
 * the minimum rather than trusting the caller's ordering, so a list sorted some other way
 * cannot move the line.
 */
export function firstToStartToday<T extends { id: string; startsAt: Date }>(
  entries: readonly T[],
  now: Date,
  timeZone: string,
): string | undefined {
  const today = dayKey(now, timeZone);
  let next: T | undefined;

  for (const entry of entries) {
    if (entry.startsAt.getTime() <= now.getTime()) continue;
    if (dayKey(entry.startsAt, timeZone) !== today) continue;
    if (!next || entry.startsAt.getTime() < next.startsAt.getTime()) next = entry;
  }

  return next?.id;
}
