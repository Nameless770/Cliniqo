/**
 * The shape patient search hands to the browser.
 *
 * Declared here, away from both the action and the data layer, for two reasons.
 *
 * The mechanical one: a `'use server'` module may export nothing but async functions, so
 * the state object and its initial value cannot live beside the action. That is a Next.js
 * rule with teeth — the module compiles and typechecks, then fails at render with "A 'use
 * server' file can only export async functions, found object", which is how this file came
 * to exist.
 *
 * The better one: this is a named view type, not a database row. `PatientListRow` is what
 * the query returns; `PatientSearchRow` is what the client is allowed to see, and writing
 * the mapping by hand in the action means adding a clinical column to the patient table
 * cannot silently widen what ships to a browser. It is the same pattern the clinical
 * components already use — `AllergyView`, `FlagView` — applied to the one list that now
 * crosses the boundary.
 */

/** Exactly the columns the patient table renders. Nothing clinical, by construction. */
export type PatientSearchRow = {
  id: string;
  mrn: string;
  legalFirstName: string;
  legalLastName: string;
  preferredName: string | null;
  dateOfBirth: string;
  phonePrimary: string | null;
  archivedAt: Date | null;
};

export type PatientSearchState = {
  rows: PatientSearchRow[];
  total: number;
  /** Echoed back so the input can stay in step with the results it is showing. */
  query: string;
  includeArchived: boolean;
  page: number;
  pageCount: number;
  /** Set when the caller may not search, or their read budget is spent. */
  message?: string;
};

export const emptyPatientSearch: PatientSearchState = {
  rows: [],
  total: 0,
  query: '',
  includeArchived: false,
  page: 1,
  pageCount: 0,
};
