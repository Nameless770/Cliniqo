-- ---------------------------------------------------------------------------
-- 0012 — `audit_event` as an audit entity type
--
-- Reading the audit log is itself an audited event, and the object of that event is the
-- log. `audit_entity_type` had no member for it.
--
-- ADD VALUE rather than a type swap: adding an enum member is an online operation and
-- leaves the existing partial indexes and the partitioned table untouched. (Recreating
-- the type would require dropping everything that references it.)
--
-- IF NOT EXISTS makes it idempotent.
-- ---------------------------------------------------------------------------

ALTER TYPE "audit_entity_type" ADD VALUE IF NOT EXISTS 'audit_event';
