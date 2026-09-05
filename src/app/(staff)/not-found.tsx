import Link from 'next/link';

import { EmptyState } from '@/components/ui';

/**
 * 404 for authenticated routes.
 *
 * Deliberately identical whether the record does not exist, belongs to another clinic, or
 * the caller may not see it. `notFound()` is what the data layer's null return becomes, so
 * this page must not distinguish those cases - "no such patient" versus "access denied"
 * tells an unauthorised user whether a given person is a patient here.
 */
export default function StaffNotFound() {
  return (
    <EmptyState
      title="Not found"
      description="That record does not exist, or you do not have access to it."
      action={<Link href="/dashboard">Back to dashboard</Link>}
    />
  );
}
