/**
 * A synthetic clinic, at realistic scale.
 *
 * ==========================================================================
 * WHY THIS EXISTS
 * ==========================================================================
 *
 * Every test in this repository runs against `seedBaseline` - one clinic, one patient, two
 * staff. That is right for correctness: a scoping bug shows up just as clearly with two
 * rows as with two million, and small fixtures keep failures readable.
 *
 * It is useless for the other class of defect. A missing index, a query that scans the
 * whole appointment table, an N+1 hidden behind a `.map`, a page that loads every audit
 * row in order to count them - none of those fail at one patient. They fail in a year, on
 * a Tuesday, and the first symptom is a receptionist saying the system has got slow.
 *
 * So this builds a clinic with thousands of patients and tens of thousands of
 * appointments, deterministically, in a few seconds.
 *
 * ==========================================================================
 * EVERY NAME AND DATE HERE IS INVENTED
 * ==========================================================================
 *
 * 164.514: development and test data must be synthetic. Nothing here is derived from a
 * real person, and the name pools are deliberately bland and obviously constructed. A
 * generator that produced plausible real identities would be a liability the first time
 * somebody pasted a row into a bug report.
 *
 * ==========================================================================
 * NO RUNTIME IMPORTS
 * ==========================================================================
 *
 * Loaded both by vitest and by a plain `node` script, so - like the maintenance jobs - it
 * speaks SQL to an injected executor and imports nothing at runtime. That also keeps
 * timezone handling in the database: appointment instants are built with `AT TIME ZONE`,
 * so the two days a year the clock shifts are Postgres's problem rather than a date
 * library's.
 */

export type Executor = (
  sql: string,
  params?: unknown[],
) => Promise<{ rowCount: number | null; rows: Record<string, unknown>[] }>;

export type DatasetOptions = {
  /** Multiplies every count. 1 is a small practice; 4 is a busy one. */
  scale?: number;
  /** Months of appointment history to generate, centred on today. */
  months?: number;
  /** Deterministic seed - the same value always builds the same clinic. */
  seed?: number;
};

export type Dataset = {
  clinicId: string;
  providerIds: string[];
  patientIds: string[];
  appointmentTypeId: string;
  counts: {
    patients: number;
    appointments: number;
    invoices: number;
    auditEvents: number;
  };
};

/*
 * A seeded PRNG (mulberry32).
 *
 * `Math.random` would make a failing performance test unreproducible: you could not tell
 * whether the run was slow or merely unlucky in its distribution. Same seed, same clinic,
 * every time.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Obviously invented, and short enough to read in a table. ASCII only, on purpose. */
const SURNAMES = [
  'Ashdown',
  'Bellweather',
  'Cadwallader',
  'Danforth',
  'Ellery',
  'Fenwick',
  'Gormley',
  'Harkness',
  'Inglewood',
  'Jellicoe',
  'Kettering',
  'Lofthouse',
  'Marchetti',
  'Northcote',
  'Oakhurst',
  'Pemberly',
  'Quillon',
  'Ravenscroft',
  'Strickland',
  'Thistlewood',
  'Underhill',
  'Vantrease',
  'Wycliffe',
  'Yarborough',
  'Zabriskie',
];

const FORENAMES = [
  'Ada',
  'Bruno',
  'Clara',
  'Dmitri',
  'Elowen',
  'Ferdinand',
  'Greta',
  'Hollis',
  'Imogen',
  'Jarrah',
  'Kestrel',
  'Lorcan',
  'Marisol',
  'Nikolai',
  'Orla',
  'Pascal',
  'Quenby',
  'Rafferty',
  'Sunniva',
  'Tobias',
  'Ulla',
  'Vidar',
  'Wilhelmina',
  'Xanthe',
  'Yusuf',
  'Zora',
];

const VISIT_REASONS = [
  'Follow-up',
  'New symptom',
  'Medication review',
  'Results discussion',
  'Routine check',
];

/** Insert in batches: one statement per N rows rather than one statement per row. */
async function insertBatched(
  exec: Executor,
  table: string,
  columns: string[],
  rows: unknown[][],
  batchSize = 500,
): Promise<number> {
  let written = 0;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const slice = rows.slice(offset, offset + batchSize);
    const params: unknown[] = [];
    const tuples = slice.map((row) => {
      const placeholders = row.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `(${placeholders.join(',')})`;
    });
    const result = await exec(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`,
      params,
    );
    written += result.rowCount ?? slice.length;
  }
  return written;
}

/** YYYY-MM-DD for a day offset from today, in plain UTC calendar terms. */
function dayOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const TIMEZONE = 'America/New_York';
/** 09:00 to 17:00 in 20-minute steps. */
const SLOTS_PER_DAY = 24;

export async function seedLargeDataset(
  exec: Executor,
  options: DatasetOptions = {},
): Promise<Dataset> {
  const scale = options.scale ?? 1;
  const months = options.months ?? 6;
  const random = rng(options.seed ?? 20260101);

  const providerCount = Math.max(2, Math.round(6 * scale));
  const patientCount = Math.round(1500 * scale);
  const tag = Math.floor(random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');

  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;

  /* ------------------------------------------------------------------ clinic */
  const clinic = await exec(
    `INSERT INTO clinic (name, timezone, mrn_prefix, currency)
     VALUES ($1, $2, $3, 'USD') RETURNING id`,
    [`Bulk Practice ${tag}`, TIMEZONE, `B${tag.slice(0, 2).toUpperCase()}`],
  );
  const clinicId = String(clinic.rows[0]!['id']);

  /* Monday to Friday, 09:00-17:00. */
  await exec(
    `INSERT INTO clinic_hours (clinic_id, day_of_week, opens_at, closes_at)
     SELECT $1, d, '09:00', '17:00' FROM generate_series(1,5) d`,
    [clinicId],
  );

  /* ------------------------------------------------------------------- staff */
  const providerIds: string[] = [];
  for (let i = 0; i < providerCount; i++) {
    const row = await exec(
      `INSERT INTO user_account (clinic_id, email, password_hash, full_name, status)
       VALUES ($1, $2, '!', $3, 'active') RETURNING id`,
      [clinicId, `bulk-doc-${i}-${tag}@example.invalid`, `Dr ${pick(SURNAMES)}`],
    );
    const id = String(row.rows[0]!['id']);
    providerIds.push(id);
    await exec(
      `INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE code = 'doctor'`,
      [id],
    );
  }

  const typeRow = await exec(
    `INSERT INTO appointment_type (clinic_id, code, display_name, default_duration_minutes)
     VALUES ($1, $2, 'Consultation', 20) RETURNING id`,
    [clinicId, `BULK_${tag.toUpperCase()}`],
  );
  const appointmentTypeId = String(typeRow.rows[0]!['id']);

  /* ---------------------------------------------------------------- patients */
  const patientRows: unknown[][] = [];
  for (let i = 0; i < patientCount; i++) {
    const year = 1935 + Math.floor(random() * 80);
    const month = 1 + Math.floor(random() * 12);
    const day = 1 + Math.floor(random() * 28);
    patientRows.push([
      clinicId,
      `B${tag.toUpperCase()}-${String(i).padStart(6, '0')}`,
      pick(FORENAMES),
      pick(SURNAMES),
      `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      /* A realistic minority have no email, so the portal invite path meets both cases. */
      random() < 0.75 ? `patient-${i}-${tag}@example.invalid` : null,
      /* And a few percent are archived, so a query that forgets `archived_at is null`
         returns a visibly wrong count rather than a plausible one. */
      random() < 0.04 ? new Date() : null,
    ]);
  }
  await insertBatched(
    exec,
    'patient',
    [
      'clinic_id',
      'mrn',
      'legal_first_name',
      'legal_last_name',
      'date_of_birth',
      'email',
      'archived_at',
    ],
    patientRows,
  );

  const patientLookup = await exec(`SELECT id FROM patient WHERE clinic_id = $1 ORDER BY mrn`, [
    clinicId,
  ]);
  const patientIds = patientLookup.rows.map((r) => String(r['id']));

  /* ------------------------------------------------------------ appointments */
  /*
   * NO OVERLAP BY CONSTRUCTION.
   *
   * `appointment_no_provider_overlap` is a GiST exclusion constraint: one clinician cannot
   * hold two live appointments at once. Rather than generate random times and retry on
   * 23P01, each clinician's day is a fixed ladder of 20-minute slots and a slot is filled
   * at most once. Generation therefore cannot collide - which keeps it fast, and keeps the
   * dataset honest: a generator that silently dropped colliding rows would produce a
   * lighter diary than it reported.
   */
  const appointmentRows: unknown[][] = [];
  const firstDay = -Math.round(months * 30 * 0.8);
  const lastDay = Math.round(months * 30 * 0.2);

  for (let offset = firstDay; offset <= lastDay; offset++) {
    const date = dayOffset(offset);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;

    for (const providerId of providerIds) {
      for (let slot = 0; slot < SLOTS_PER_DAY; slot++) {
        // A realistically imperfect diary: roughly two thirds of slots are taken.
        if (random() > 0.66) continue;

        const minutes = 9 * 60 + slot * 20;
        const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
        const mm = String(minutes % 60).padStart(2, '0');

        const past = offset < 0;
        const roll = random();
        const status = past
          ? roll < 0.82
            ? 'completed'
            : roll < 0.92
              ? 'no_show'
              : 'cancelled'
          : roll < 0.9
            ? 'scheduled'
            : 'cancelled';

        appointmentRows.push([
          clinicId,
          patientIds[Math.floor(random() * patientIds.length)],
          providerId,
          appointmentTypeId,
          `${date} ${hh}:${mm}:00`,
          TIMEZONE,
          status,
          pick(VISIT_REASONS),
        ]);
      }
    }
  }

  /*
   * The instant is built in SQL from a clinic-local wall clock. `AT TIME ZONE` applies the
   * real offset for that date, so a DST boundary is handled by the database's tz data
   * rather than by arithmetic here.
   */
  let appointmentsWritten = 0;
  for (let offset = 0; offset < appointmentRows.length; offset += 400) {
    const slice = appointmentRows.slice(offset, offset + 400);
    const params: unknown[] = [];
    const tuples = slice.map((row) => {
      const b = params.length;
      params.push(...row);
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4},
        tstzrange(
          ($${b + 5}::timestamp AT TIME ZONE $${b + 6}),
          (($${b + 5}::timestamp + interval '20 minutes') AT TIME ZONE $${b + 6})
        ),
        $${b + 7}::appointment_status, $${b + 8})`;
    });
    const result = await exec(
      `INSERT INTO appointment
         (clinic_id, patient_id, provider_user_id, appointment_type_id, during, status,
          booking_note)
       VALUES ${tuples.join(',')}`,
      params,
    );
    appointmentsWritten += result.rowCount ?? slice.length;
  }

  /* ---------------------------------------------------------------- invoices */
  const invoiceRows: unknown[][] = [];
  const billed = patientIds.slice(0, Math.floor(patientIds.length * 0.4));
  for (const patientId of billed) {
    const roll = random();
    invoiceRows.push([
      clinicId,
      patientId,
      'USD',
      roll < 0.55 ? 'paid' : roll < 0.9 ? 'issued' : 'draft',
      roll < 0.9 ? new Date() : null,
    ]);
  }
  await insertBatched(
    exec,
    'invoice',
    ['clinic_id', 'patient_id', 'currency', 'status', 'issued_at'],
    invoiceRows,
  );

  /*
   * Lines are added while every invoice is still a draft, because `invoice_line_frozen_guard`
   * refuses an insert against an issued one - the dataset has to obey the same rules the
   * application does.
   */
  const invoiceLookup = await exec(
    `SELECT id FROM invoice WHERE clinic_id = $1 AND status = 'draft'`,
    [clinicId],
  );
  const lineRows = invoiceLookup.rows.map((r) => [
    String(r['id']),
    'Consultation',
    1,
    2500 + Math.floor(random() * 20) * 500,
  ]);
  await insertBatched(
    exec,
    'invoice_line',
    ['invoice_id', 'description', 'quantity', 'unit_amount_cents'],
    lineRows,
  );

  /* ----------------------------------------------------------- audit events */
  /*
   * The highest-insert table in the system, and the one whose read performance decays
   * first. It is partitioned by month for exactly that reason, so the rows are spread
   * across several months to exercise partition pruning rather than piling into one.
   */
  const auditRows: unknown[][] = [];
  const actions = [
    'patient.read',
    'patient.search',
    'appointment.read',
    'note.read',
    'invoice.read',
  ];
  const auditTarget = Math.round(20_000 * scale);
  for (let i = 0; i < auditTarget; i++) {
    const daysAgo = Math.floor(random() * months * 30);
    const hour = String(9 + Math.floor(random() * 8)).padStart(2, '0');
    auditRows.push([
      clinicId,
      providerIds[Math.floor(random() * providerIds.length)],
      patientIds[Math.floor(random() * patientIds.length)],
      pick(actions),
      random() < 0.02 ? 'denied' : 'allowed',
      `${dayOffset(-daysAgo)} ${hour}:00:00+00`,
    ]);
  }
  /*
   * The id is built in SQL as a UUIDv7 derived from the row's own timestamp.
   *
   * `audit_event` has no default on `id` on purpose - the application supplies a v7
   * because a v4 scatters inserts across the whole B-tree, and this is the hottest table
   * in the system. A dataset seeded with random v4 keys would leave the index in a shape
   * production never sees, which would make every measurement below a measurement of the
   * wrong thing.
   *
   * Layout: 48 bits of millisecond timestamp, the version nibble 7, then random.
   */
  for (let offset = 0; offset < auditRows.length; offset += 400) {
    const slice = auditRows.slice(offset, offset + 400);
    const params: unknown[] = [];
    const tuples = slice.map((row) => {
      const b = params.length;
      params.push(...row);
      return `(
        (
          lpad(to_hex((extract(epoch from $${b + 6}::timestamptz) * 1000)::bigint), 12, '0')
          || '7' || substr(md5(random()::text), 1, 3)
          || to_hex(8 + floor(random() * 4)::int) || substr(md5(random()::text), 1, 3)
          || substr(md5(random()::text), 1, 12)
        )::uuid,
        $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::audit_outcome,
        $${b + 6}::timestamptz)`;
    });
    await exec(
      `INSERT INTO audit_event
         (id, clinic_id, actor_user_id, subject_patient_id, action, outcome, occurred_at)
       VALUES ${tuples.join(',')}`,
      params,
    );
  }

  /* Statistics, so the planner chooses indexes rather than guessing from stale estimates.
     Without this the first query after a bulk load can be misleadingly slow. */
  await exec('ANALYZE patient, appointment, audit_event, invoice, invoice_line');

  return {
    clinicId,
    providerIds,
    patientIds,
    appointmentTypeId,
    counts: {
      patients: patientIds.length,
      appointments: appointmentsWritten,
      invoices: invoiceRows.length,
      auditEvents: auditRows.length,
    },
  };
}
