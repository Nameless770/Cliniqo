'use server';

import { patientSearchInput } from '@/lib/patient-schemas';
import {
  emptyPatientSearch,
  type PatientSearchRow,
  type PatientSearchState,
} from '@/lib/patient-search';
import { AuthorizationError } from '@/server/auth/authorize';
import { ReadBudgetExceededError } from '@/server/data-access/audited';
import { searchPatients, type PatientListRow } from '@/server/data-access/patients';

/**
 * Patient search, as a server action rather than a page navigation.
 *
 * This exists so the receptionist's most-used screen answers while they type. Two things
 * about it are security decisions rather than UX ones, and both cut the same way.
 *
 * THE QUERY NEVER ENTERS A URL. The page it replaces carried the search term in `?q=`,
 * reasoning that a staff-typed query is not a patient identifier. That holds for "diabetic
 * clinic" and fails completely for "Mohammed Hassan", which is what the box is actually
 * used for — and a name in a query string is a name in browser history, in the `Referer`
 * header of every outbound link from that page, and in any proxy log between here and the
 * browser. A POST body is none of those things. The interactive version is the compliant
 * one, which is a happy alignment and not a coincidence: the URL was only ever carrying
 * that value to survive a page load this no longer performs.
 *
 * IT RE-CHECKS AUTHORIZATION ITSELF. It does not trust that the page which rendered the
 * box already did. `searchPatients` goes through `auditedSearch`, so the permission check,
 * the read-budget check and the audit row all happen inside one transaction, exactly as
 * they do for the page. An action reachable by anyone who can POST is a different trust
 * level from a page, and it is checked like one.
 *
 * ON READ-BUDGET COST: `patient.search` counts against the PHI read ceiling (F1), so
 * search-as-you-type could have burned a clinician's budget in a few names. The client
 * debounces and refuses to search below two characters; measured in a browser, typing an
 * eight-character surname charges exactly one event, not eight. The throttle is
 * deliberately NOT relaxed to accommodate this feature — a control that gets widened
 * whenever a feature finds it inconvenient is not a control.
 */

/**
 * Query row to view row, field by field.
 *
 * Deliberately not a spread. A spread would carry whatever the query happens to select
 * today, so widening `PatientListRow` later would widen what reaches the browser without
 * anyone deciding to.
 */
function toView(row: PatientListRow): PatientSearchRow {
  return {
    id: row.id,
    mrn: row.mrn,
    legalFirstName: row.legalFirstName,
    legalLastName: row.legalLastName,
    preferredName: row.preferredName,
    dateOfBirth: row.dateOfBirth,
    phonePrimary: row.phonePrimary,
    archivedAt: row.archivedAt,
  };
}

export async function searchPatientsAction(
  _previous: PatientSearchState,
  formData: FormData,
): Promise<PatientSearchState> {
  const parsed = patientSearchInput.safeParse({
    query: formData.get('q') ?? '',
    includeArchived: formData.get('archived') === '1',
    page: formData.get('page') ?? 1,
  });

  /* A malformed query is a bad request, not a crash: answer with an empty result. */
  if (!parsed.success) return emptyPatientSearch;

  try {
    const list = await searchPatients(parsed.data);
    return {
      rows: list.rows.map(toView),
      total: list.total,
      query: parsed.data.query,
      includeArchived: parsed.data.includeArchived,
      page: list.page,
      pageCount: list.pageCount,
    };
  } catch (error) {
    /*
     * The read budget is spent. Said plainly rather than as a generic failure: a
     * receptionist who cannot find a patient needs to know this is a throttle and not a
     * missing record, or they will retype the name and spend what is left of it.
     */
    if (error instanceof ReadBudgetExceededError) {
      return {
        ...emptyPatientSearch,
        query: parsed.data.query,
        includeArchived: parsed.data.includeArchived,
        page: parsed.data.page,
        message:
          'Too many record lookups in a short period. Wait a moment before searching again.',
      };
    }

    if (error instanceof AuthorizationError) {
      return {
        ...emptyPatientSearch,
        query: parsed.data.query,
        includeArchived: parsed.data.includeArchived,
        page: parsed.data.page,
        message:
          error.reason === 'UNAUTHENTICATED'
            ? 'Your session has ended. Sign in again.'
            : 'You do not have permission to search patients. The attempt has been recorded.',
      };
    }
    /*
     * Anything else is unexpected. It is rethrown rather than rendered: the error boundary
     * shows a generic page, and the message — which can quote a query that names a patient
     * — never reaches the browser as text this action chose to return.
     */
    throw error;
  }
}
