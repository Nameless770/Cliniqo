import { describe, expect, it } from 'vitest';

import {
  clinicWallClock,
  firstToStartToday,
  isClinicOpen,
  type WeeklyHours,
} from '@/lib/clinic-now';

/**
 * "Open now" and the schedule's Now line, at the times they are most likely to be wrong.
 *
 * Both are statements the interface makes about the real world — a patient may travel to a
 * clinic the portal calls open — so they are tested with a fixed instant rather than the
 * system clock. A test that reads `new Date()` passes at 2pm and fails at midnight, and the
 * last one of those in this suite failed one run in sixteen before anyone noticed.
 */

/* Weekdays 09:00-17:00, as `clinic_hours` stores them: 1 = Monday. */
const weekdays: WeeklyHours[] = [1, 2, 3, 4, 5].map((dayOfWeek) => ({
  dayOfWeek,
  opensAt: '09:00:00',
  closesAt: '17:00:00',
}));

describe("the clinic's wall clock", () => {
  it('reads the date and time in the clinic zone, in the study format', () => {
    // 08:41:08 UTC is 09:41:08 in London during British Summer Time.
    const wall = clinicWallClock(new Date('2026-09-07T08:41:08Z'), 'Europe/London');

    expect(wall.date).toBe('Monday 7 September 2026');
    expect(wall.hms).toBe('09:41:08');
    expect(wall.hm).toBe('09:41');
    expect(wall.dayOfWeek).toBe(1);
  });

  it('takes its weekday from the clinic, not from UTC', () => {
    /*
     * Tuesday 02:00 UTC is still Monday evening in Los Angeles. Judged by the UTC weekday,
     * a West Coast clinic's Monday hours would be checked against Tuesday's.
     */
    const wall = clinicWallClock(new Date('2026-09-08T02:00:00Z'), 'America/Los_Angeles');
    expect(wall.dayOfWeek).toBe(1);
    expect(wall.hm).toBe('19:00');
  });
});

describe('whether the clinic is open', () => {
  it('is open inside the hours', () => {
    expect(
      isClinicOpen(new Date('2026-09-07T09:30:00+01:00'), 'Europe/London', weekdays, []),
    ).toBe(true);
  });

  it('opens on the stroke of opening time and closes on the stroke of closing time', () => {
    const at = (clock: string) =>
      isClinicOpen(new Date(`2026-09-07T${clock}+01:00`), 'Europe/London', weekdays, []);

    expect(at('08:59:59')).toBe(false);
    expect(at('09:00:00')).toBe(true);
    expect(at('16:59:59')).toBe(true);
    // Closing time is the first moment it is shut, not the last moment it is open.
    expect(at('17:00:00')).toBe(false);
  });

  it('is closed on a day with no hours', () => {
    // Sunday.
    expect(
      isClinicOpen(new Date('2026-09-13T11:00:00+01:00'), 'Europe/London', weekdays, []),
    ).toBe(false);
  });

  it('is closed during a clinic-wide closure, even inside its normal hours', () => {
    /*
     * The case that justifies passing closures to the browser at all. A bank holiday is not
     * a change to the weekly timetable, so the hours alone would call the clinic open.
     */
    const bankHoliday = [
      { startsAt: '2026-08-31T00:00:00+01:00', endsAt: '2026-09-01T00:00:00+01:00' },
    ];
    const monday = new Date('2026-08-31T10:00:00+01:00');

    expect(isClinicOpen(monday, 'Europe/London', weekdays, [])).toBe(true);
    expect(isClinicOpen(monday, 'Europe/London', weekdays, bankHoliday)).toBe(false);
    // And open again the next morning, when the closure has ended.
    expect(
      isClinicOpen(
        new Date('2026-09-01T10:00:00+01:00'),
        'Europe/London',
        weekdays,
        bankHoliday,
      ),
    ).toBe(true);
  });

  it("uses the clinic's weekday near midnight in a zone west of Greenwich", () => {
    // Open Monday evenings until 21:00, Los Angeles.
    const lateMonday: WeeklyHours[] = [
      { dayOfWeek: 1, opensAt: '17:00:00', closesAt: '21:00:00' },
    ];
    // 03:30 UTC Tuesday = 20:30 Monday in Los Angeles: open, although it is Tuesday in UTC.
    expect(
      isClinicOpen(
        new Date('2026-09-08T03:30:00Z'),
        'America/Los_Angeles',
        lateMonday,
        [],
      ),
    ).toBe(true);
  });
});

describe('where the Now line falls', () => {
  const tz = 'Europe/London';
  const entry = (id: string, iso: string) => ({ id, startsAt: new Date(iso) });

  const today = [
    entry('a', '2026-09-07T09:00:00+01:00'),
    entry('b', '2026-09-07T10:00:00+01:00'),
    entry('c', '2026-09-07T11:00:00+01:00'),
  ];

  it('sits above the first appointment that has not started yet', () => {
    expect(firstToStartToday(today, new Date('2026-09-07T09:41:00+01:00'), tz)).toBe('b');
  });

  it('treats an appointment starting this very moment as already begun', () => {
    expect(firstToStartToday(today, new Date('2026-09-07T10:00:00+01:00'), tz)).toBe('c');
  });

  it('draws nothing once every appointment today has begun', () => {
    expect(
      firstToStartToday(today, new Date('2026-09-07T11:30:00+01:00'), tz),
    ).toBeUndefined();
  });

  it("never marks tomorrow's first appointment from today", () => {
    /*
     * In a week view the next future row may well be tomorrow's. Putting the line above it
     * would claim "now" is between today's last visit and tomorrow's first — which is true,
     * but reads as though that appointment were imminent.
     */
    const withTomorrow = [...today, entry('tomorrow', '2026-09-08T09:00:00+01:00')];
    expect(
      firstToStartToday(withTomorrow, new Date('2026-09-07T11:30:00+01:00'), tz),
    ).toBeUndefined();
  });

  it('does not depend on the order it is given', () => {
    const shuffled = [today[2]!, today[0]!, today[1]!];
    expect(firstToStartToday(shuffled, new Date('2026-09-07T09:41:00+01:00'), tz)).toBe(
      'b',
    );
  });

  it('decides "today" in the clinic zone, not in UTC', () => {
    /*
     * The two instants must fall on DIFFERENT days in UTC and the SAME day in the clinic,
     * or a UTC comparison passes this too. 16:30 Monday in Los Angeles is 23:30 UTC Monday;
     * 17:30 Monday local is 00:30 UTC Tuesday. Still today's appointment, locally.
     */
    const la = 'America/Los_Angeles';
    const evening = [entry('evening', '2026-09-08T00:30:00Z')]; // 17:30 Mon, LA
    expect(firstToStartToday(evening, new Date('2026-09-07T23:30:00Z'), la)).toBe(
      'evening',
    );
  });
});
