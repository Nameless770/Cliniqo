/**
 * Audited data access.
 *
 * Import from here, never from the modules beneath it, so the entry points stay a short
 * reviewable list.
 */
export { auditedRead, auditedWrite, auditedSearch, type AuditedSpec } from './audited';
