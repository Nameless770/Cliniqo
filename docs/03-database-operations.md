# Cliniqo — Database Operations

How migrations run locally and in deployment, and the constraints that shape both.

---

## The two-role rule

Everything below follows from one decision: **the application never connects as the
schema owner.**

| Role            | Used by                   | Rights                                                                     |
| --------------- | ------------------------- | -------------------------------------------------------------------------- |
| `cliniqo_owner` | `npm run db:migrate` only | Owns the schema. Full DDL.                                                 |
| `cliniqo_app`   | The running application   | DML on business tables. **INSERT + SELECT only on `audit_event`.** No DDL. |

If both were the same role, the audit log's immutability would be decorative — the
application could drop the trigger that protects it. Verified behaviour as `cliniqo_app`:

```
UPDATE audit_event ...                          ERROR: permission denied for table audit_event
DELETE FROM audit_event ...                     ERROR: permission denied for table audit_event
DROP TABLE patient;                             ERROR: must be owner of table patient
ALTER TABLE audit_event DISABLE TRIGGER ...;    ERROR: must be owner of table audit_event
```

`cliniqo_app` is created **without a password** by migration 0001. A credential in a
migration file is a credential in version control. Local development sets a throwaway
password via `npm run db:setup`; production provisions it out of band.

---

## Running migrations locally

First time:

```bash
cp .env.example .env
docker compose up -d
npm run db:setup
```

`db:setup` waits for Postgres, applies every migration, then sets the local-only
`cliniqo_app` password. To wipe and rebuild from scratch:

```bash
npm run db:reset
```

After changing a schema file:

```bash
npm run db:generate -- --name=short_description
npm run db:migrate
```

Never `drizzle-kit push`. It diffs the live database and applies changes directly, with no
reviewable artifact and no ordering guarantee — the opposite of what an audited system
needs. It is not in `package.json` for that reason.

### Two migrations that must not be regenerated blindly

`0000_initial_schema.sql` is **hand-edited** after generation, marked with `EDIT` comments:
the three `CREATE EXTENSION` statements, and `PARTITION BY RANGE` on `audit_event`.
drizzle-kit tracks migrations by journal entry rather than file checksum, so the edits
survive; but a regeneration from scratch would drop them.

`0001_cliniqo_hardening.sql` is entirely hand-written. It carries the exclusion constraint,
the partitioning, the privileges, and the immutability triggers — everything the schema DSL
cannot express. Without it the schema looks correct and silently lacks its safety
properties.

---

## Deployment

### Migrations are a separate step, never application startup

Running migrations on boot is a common shortcut and wrong here for three reasons:

1. **Replicas race.** Rolling out three containers means three concurrent migration
   attempts against one database.
2. **The app role cannot do it.** `cliniqo_app` has no DDL rights, by design.
3. **A failed migration should not produce a crash-looping application.** It should fail
   one job, loudly, while the previous version keeps serving.

The migration runs as its own unit — an ECS pre-deploy task, a Kubernetes Job, or a
`release` command — connecting as `cliniqo_owner`, before new application containers start.

```
backup verified  ->  migrate (owner role)  ->  deploy app (app role)  ->  smoke test
```

### `lock_timeout` is set to 10 seconds

`scripts/migrate.js` sets this before applying anything. A migration needing `ACCESS
EXCLUSIVE` will queue behind any open transaction holding a conflicting lock — and while it
queues, it blocks every other query on that table. The clinic stops working. Failing fast
and retrying is strictly better than a lock convoy during clinic hours.

`statement_timeout` is disabled for the migration connection: migrations legitimately run
longer than requests, and `lock_timeout` is the control that actually matters.

### Zero-downtime changes use expand/contract

Old and new application versions overlap during a rollout, so a single migration must be
compatible with both. Destructive changes are split across releases:

1. **Expand** — add the new nullable column / new table / new index (`CONCURRENTLY`).
2. **Backfill** — in batches, outside the migration.
3. **Migrate reads and writes** — application release that uses the new shape.
4. **Contract** — drop the old column, a release later.

Adding `NOT NULL` to an existing column, renaming, and dropping are all step-4 operations,
never step-1.

### Forward-only

There are no `down` migrations. Rolling a schema backwards on a database that has taken
writes destroys data, and for clinical records that is not recoverable and not lawful.
A bad migration is fixed by a new migration forward. This is also why the backup must be
verified _before_ the migration runs, not merely scheduled.

### CI

On every pull request:

```
npm run typecheck
npm run db:check          # migration journal consistency
docker compose up -d      # ephemeral Postgres
npm run db:migrate        # migrations must apply to a clean database
npm run db:generate       # then assert no new migration was produced
```

That last step is the important one: if `generate` produces a file, someone changed a
schema module without committing its migration, and the deployed database would silently
drift from the code. Fail the build.

---

## Scheduled maintenance

**Audit partitions.** `cliniqo_create_audit_partition(date)` creates a month. Migration
0001 seeded 26 months. A monthly job must extend the window:

```sql
SELECT cliniqo_create_audit_partition((date_trunc('month', now()) + interval '12 months')::date);
```

`audit_event_default` exists as a safety net so an audit write never fails for a missing
partition — losing an audit write is worse than an unpartitioned row. **It should always be
empty; alert if it is not**, because a non-empty default means this job has stopped running.

New partitions are automatically stripped of `UPDATE`/`DELETE` for `cliniqo_app` by the
`cliniqo_audit_partition_privileges` event trigger. Partition privileges are not inherited
from the parent table, so without that trigger a partition created next year would be
writable. This was verified against a partition created after the migration ran.

**Retention.** Nothing is purged. Six years is the HIPAA documentation floor
(§164.316(b)(2)(i)); state medical-record law governs the rest and has not yet been
determined (see requirements analysis, M11). When purging is eventually permitted, it is
`DETACH PARTITION` then `DROP` — DDL, which the immutability trigger does not block, run by
the owner role.

**Backups.** Encrypted at rest, with a **tested restore** — §164.308(a)(7) requires the
drill, not just the backup job. Note that a restore also restores the audit log, so the
restore target must have the same role separation or the log becomes editable in the
recovered environment.

---

## Known dependency exception

`npm audit` reports 4 moderate advisories, all one transitive chain:
`drizzle-kit -> @esbuild-kit/esm-loader -> esbuild <=0.24.2` (GHSA-67mh-4wv8-2f99).

Accepted, with reasons: it is a **dev dependency** and never enters a runtime image; the
vulnerability requires running esbuild's `--serve` dev server, which drizzle-kit does not
do (it uses esbuild to bundle the config file); and `npm audit fix --force` would downgrade
drizzle-kit to 0.18.1, which cannot generate this schema. Revisit when drizzle-kit 1.0
leaves pre-release — it drops the deprecated `@esbuild-kit` packages.

The high-severity advisory that _was_ actionable — GHSA-gpj5-g38j-94v9, SQL injection via
improperly escaped identifiers in `drizzle-orm < 0.45.2` — is fixed by pinning
`drizzle-orm ^0.45.2`. That one is production code handling PHI and was not negotiable.
