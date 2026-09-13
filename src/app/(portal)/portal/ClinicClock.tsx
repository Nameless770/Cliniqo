'use client';

import { useEffect, useState } from 'react';

import {
  clinicWallClock,
  isClinicOpen,
  type Closure,
  type WeeklyHours,
} from '@/lib/clinic-now';

/**
 * The live half of the portal masthead: whether the clinic is open, and its clock.
 *
 * A Client Component because it ticks. It is handed the clinic's time zone, its weekly
 * hours and today's closures — clinic configuration, identical for every patient — and
 * nothing about the patient reading it. The patient's own next appointment is rendered
 * beside this by the server, deliberately outside the island.
 *
 * NOT an aria-live region. A clock announced every second would make the page unusable
 * with a screen reader; the time is there to be read, not to interrupt.
 *
 * Under `prefers-reduced-motion` it drops the seconds and changes once a minute, the
 * portal's equivalent of the study's motion switch, which stops this clock entirely. A
 * figure changing every second is motion in the sense that matters to someone who has
 * asked for less of it.
 */
export function ClinicClock({
  timeZone,
  hours,
  closures,
}: {
  timeZone: string;
  hours: WeeklyHours[];
  closures: Closure[];
}) {
  const [now, setNow] = useState(() => new Date());
  const [calm, setCalm] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setCalm(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), calm ? 15_000 : 1_000);
    return () => window.clearInterval(id);
  }, [calm]);

  const wall = clinicWallClock(now, timeZone);
  const open = isClinicOpen(now, timeZone, hours, closures);

  /*
   * suppressHydrationWarning on exactly the nodes whose text is a function of the clock:
   * the server drew them a moment before the browser did, and a one-second disagreement
   * is expected rather than a bug. It is not applied anywhere else.
   */
  return (
    <>
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '7px',
          fontSize: '10px',
          fontWeight: 'var(--weight-semibold)',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--text-secondary)',
        }}
      >
        {/*
          The pulsing dot only while open. A "live" signal beside the word Closed would be
          saying two contradictory things at once.
        */}
        <span
          aria-hidden="true"
          className={open ? 'cq-live-dot' : undefined}
          style={
            open
              ? undefined
              : {
                  display: 'inline-block',
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: 'var(--neutral-400)',
                }
          }
          suppressHydrationWarning
        />
        <span suppressHydrationWarning>{open ? 'Open now' : 'Closed now'}</span>
      </span>

      <span
        aria-hidden="true"
        style={{ width: '1px', height: '13px', background: 'var(--border-subtle)' }}
      />

      <span
        style={{
          fontSize: 'var(--text-sm)',
          color: 'var(--text-secondary)',
          fontVariantNumeric: 'tabular-nums',
        }}
        suppressHydrationWarning
      >
        {wall.date} · {calm ? wall.hm : wall.hms} clinic time
      </span>
    </>
  );
}
