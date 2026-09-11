/**
 * Schema barrel.
 *
 * `drizzle.config.ts` points at this file, and the db client passes it to `drizzle()` so
 * that every query is typed against the full schema.
 */

export * from './enums';
export * from './shared';

export * from './clinic';
export * from './identity';
export * from './portal';
export * from './patient';
export * from './scheduling';
export * from './clinical';
export * from './prescribing';
export * from './billing';
export * from './triage';
export * from './audit';
export * from './maintenance';
