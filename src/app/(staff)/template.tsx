/**
 * Replays the screen fade on every navigation between staff sections.
 *
 * A template, not the layout, because a template is REMOUNTED when the segment beneath it
 * changes and a layout never is — that remount is what restarts the CSS animation. Per the
 * Next docs it keys on the child segment only: moving Dashboard -> Schedule fades, while
 * stepping the schedule a day forward (a search-param change) does not, which is the
 * difference between a screen arriving and a list updating.
 *
 * A Server Component with no state: it adds one class and ships no JavaScript.
 */
export default function StaffTemplate({ children }: { children: React.ReactNode }) {
  return <div className="cq-screen">{children}</div>;
}
