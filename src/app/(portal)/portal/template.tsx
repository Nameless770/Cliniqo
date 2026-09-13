/**
 * The same screen fade for the patient portal. See `(staff)/template.tsx` for why this is
 * a template rather than part of the layout.
 *
 * Placed at `portal/`, not at the `(portal)` group: a template keys on the segment BELOW
 * it, and below the group there is only ever `portal`, so a template there would never
 * remount between the portal's own pages.
 */
export default function PortalTemplate({ children }: { children: React.ReactNode }) {
  return <div className="cq-screen">{children}</div>;
}
