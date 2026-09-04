-- ---------------------------------------------------------------------------
-- 0001 — constraints and guarantees drizzle-kit cannot express
--
-- Everything here was promised by the approved data model. Without this migration the
-- schema looks correct and silently lacks its central safety properties: double-booking
-- is possible, the audit log is editable, and signed notes are mutable.
--
-- Hand-written on purpose. Drizzle's schema DSL has no representation for exclusion
-- constraints, table partitioning, database privileges, or triggers.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- 1. Concurrent double-booking
-- ===========================================================================
-- Two receptionists booking the same provider and slot at the same instant BOTH read
-- "slot free" before either writes. No application-level availability check can prevent
-- this — only the database can, by rejecting the second write.
--
-- Partial, excluding cancelled and no_show. The partiality is not optional: without it a
-- cancelled appointment would block its slot permanently.
--
-- `btree_gist` is what allows the equality operator on a scalar (provider_user_id) to be
-- combined with range overlap in one GiST constraint.
ALTER TABLE "appointment"
  ADD CONSTRAINT "appointment_no_provider_overlap"
  EXCLUDE USING gist (
    "provider_user_id" WITH =,
    "during" WITH &&
  )
  WHERE ("status" NOT IN ('cancelled', 'no_show') AND "archived_at" IS NULL);
--> statement-breakpoint

-- Clinic-wide day view: "everything happening between these two instants".
CREATE INDEX "appointment_clinic_during_idx"
  ON "appointment" USING gist ("clinic_id", "during");
--> statement-breakpoint

-- Availability calculation scans closures and time off by range.
CREATE INDEX "schedule_exception_during_idx"
  ON "schedule_exception" USING gist ("clinic_id", "during");
--> statement-breakpoint


-- ===========================================================================
-- 2. Audit log partitioning
-- ===========================================================================
-- `audit_event` was declared PARTITION BY RANGE (occurred_at) in 0000. A partitioned
-- table with no partitions rejects every insert, and an audit write that fails is a
-- write we cannot afford to lose — so the DEFAULT partition is created FIRST.

-- Safety net. Should always be empty; alert if it is not, because a non-empty default
-- means monthly partition creation has fallen behind.
CREATE TABLE "audit_event_default" PARTITION OF "audit_event" DEFAULT;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION cliniqo_create_audit_partition(month_start date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  partition_name text := 'audit_event_' || to_char(month_start, 'YYYY_MM');
  range_start    date := date_trunc('month', month_start)::date;
  range_end      date := (date_trunc('month', month_start) + interval '1 month')::date;
BEGIN
  IF to_regclass(format('public.%I', partition_name)) IS NOT NULL THEN
    RETURN;
  END IF;

  EXECUTE format(
    'CREATE TABLE %I PARTITION OF audit_event FOR VALUES FROM (%L) TO (%L)',
    partition_name, range_start, range_end
  );
END;
$$;
--> statement-breakpoint

-- Seed the current month plus 24 ahead, and one month back to cover clock skew at the
-- boundary. A scheduled job extends this window; the DEFAULT partition covers the gap if
-- that job ever fails.
DO $$
DECLARE
  m date := (date_trunc('month', now()) - interval '1 month')::date;
BEGIN
  WHILE m <= (date_trunc('month', now()) + interval '24 months')::date LOOP
    PERFORM cliniqo_create_audit_partition(m);
    m := (m + interval '1 month')::date;
  END LOOP;
END;
$$;
--> statement-breakpoint


-- ===========================================================================
-- 3. Audit log immutability
-- ===========================================================================
-- Append-only, enforced in the database rather than by application discipline.
--
-- Retention is six years (§164.316(b)(2)(i)) and may be longer under state law. Purging,
-- when it is eventually permitted, happens by DETACH + DROP of a whole partition — DDL,
-- which this trigger does not touch.
CREATE OR REPLACE FUNCTION cliniqo_audit_event_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'audit_event is append-only (attempted %). Audit rows are evidence and cannot be modified.',
    TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$;
--> statement-breakpoint

-- Catches the table owner too, not only the application role. A privilege check alone
-- would leave the log editable by whoever runs migrations.
CREATE TRIGGER "audit_event_no_update"
  BEFORE UPDATE OR DELETE ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION cliniqo_audit_event_immutable();
--> statement-breakpoint


-- ===========================================================================
-- 4. Application role and privileges
-- ===========================================================================
-- The application connects as `cliniqo_app`, which is NOT the schema owner. It cannot
-- run DDL, and it holds INSERT + SELECT on audit_event and nothing else.
--
-- No password is set here — a credential in a migration file is a credential in version
-- control. Infrastructure provisions it out of band. On managed platforms where role
-- creation is handled by the provider, the DO block below is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cliniqo_app') THEN
    CREATE ROLE cliniqo_app LOGIN;
  END IF;
END;
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO cliniqo_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cliniqo_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cliniqo_app;--> statement-breakpoint

-- Then take back what the audit log must never allow. Order matters: the blanket grant
-- above includes audit_event, so this revoke has to follow it.
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_event" FROM cliniqo_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_event_default" FROM cliniqo_app;--> statement-breakpoint

-- Privileges on partitions are not inherited from the parent, so every monthly partition
-- needs the same treatment. Applied to existing partitions here; new ones are handled by
-- the event trigger below.
DO $$
DECLARE
  part text;
BEGIN
  FOR part IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'audit_event'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT ON %I TO cliniqo_app', part);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM cliniqo_app', part);
  END LOOP;
END;
$$;
--> statement-breakpoint

-- Future tables created by the owner.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cliniqo_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO cliniqo_app;
--> statement-breakpoint

-- New audit partitions are created by a scheduled job, long after this migration runs.
-- Without this, a partition created next year would silently be writable by the app role.
CREATE OR REPLACE FUNCTION cliniqo_lock_new_audit_partitions()
RETURNS event_trigger
LANGUAGE plpgsql
AS $$
DECLARE
  obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands() WHERE command_tag = 'CREATE TABLE'
  LOOP
    IF obj.object_identity LIKE 'public.audit_event%' THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM cliniqo_app', obj.object_identity);
      EXECUTE format('GRANT SELECT, INSERT ON %s TO cliniqo_app', obj.object_identity);
    END IF;
  END LOOP;
END;
$$;
--> statement-breakpoint

CREATE EVENT TRIGGER "cliniqo_audit_partition_privileges"
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE')
  EXECUTE FUNCTION cliniqo_lock_new_audit_partitions();
--> statement-breakpoint


-- ===========================================================================
-- 5. Signed clinical records are frozen
-- ===========================================================================
-- A draft note version is mutable in place; once signed, `frozen_at` is set and the row
-- is never updated again. Corrections append an addendum (§164.526).
--
-- Enforced here rather than only in the write path, because "the legal record cannot be
-- altered" should not depend on every future code path remembering to check.
CREATE OR REPLACE FUNCTION cliniqo_visit_note_version_frozen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.frozen_at IS NOT NULL THEN
    RAISE EXCEPTION
      'visit_note_version % was signed at % and cannot be modified. Append an addendum instead.',
      OLD.id, OLD.frozen_at
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "visit_note_version_frozen_guard"
  BEFORE UPDATE OR DELETE ON "visit_note_version"
  FOR EACH ROW EXECUTE FUNCTION cliniqo_visit_note_version_frozen();
--> statement-breakpoint


-- ===========================================================================
-- 6. Controlled substances are out of scope, enforced in data
-- ===========================================================================
-- Prescribing controlled substances electronically requires DEA EPCS compliance:
-- third-party identity proofing of every prescriber and hard two-factor at signing.
-- Cliniqo does none of that, so the database refuses the write rather than relying on
-- the UI not to offer the option.
CREATE OR REPLACE FUNCTION cliniqo_block_controlled_substances()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  controlled boolean;
  med_name   text;
BEGIN
  SELECT m.is_controlled, m.name INTO controlled, med_name
  FROM medication m WHERE m.id = NEW.medication_id;

  IF controlled THEN
    RAISE EXCEPTION
      'Cannot prescribe % : controlled substances require DEA EPCS compliance, which Cliniqo does not implement.',
      med_name
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "prescription_item_no_controlled"
  BEFORE INSERT OR UPDATE ON "prescription_item"
  FOR EACH ROW EXECUTE FUNCTION cliniqo_block_controlled_substances();
--> statement-breakpoint


-- ===========================================================================
-- 7. Signed prescriptions are frozen
-- ===========================================================================
-- Correction means cancelling the prescription and issuing a new one — which is how
-- paper prescriptions work and what the legal record expects.
CREATE OR REPLACE FUNCTION cliniqo_prescription_item_frozen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT p.status::text INTO parent_status
  FROM prescription p
  WHERE p.id = COALESCE(NEW.prescription_id, OLD.prescription_id);

  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION
      'Prescription is % and its items cannot be changed. Cancel it and issue a new prescription.',
      parent_status
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "prescription_item_frozen_guard"
  BEFORE UPDATE OR DELETE ON "prescription_item"
  FOR EACH ROW EXECUTE FUNCTION cliniqo_prescription_item_frozen();
