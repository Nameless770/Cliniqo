import 'server-only';

import { eq } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { clinic } from '@/db/schema';

/**
 * A clinic's display name, for a page that has no session yet — the sign-up confirmation,
 * which should say which practice the person is about to join.
 *
 * Not audited and not permission-checked: a clinic's name is what is on the sign outside the
 * building. It is looked up only by the configured SIGNUP_CLINIC_ID, never by an id taken
 * from a request, so it cannot be used to list clinics.
 */
export async function clinicDisplayName(clinicId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ name: clinic.name })
    .from(clinic)
    .where(eq(clinic.id, clinicId))
    .limit(1);
  return row?.name ?? null;
}
