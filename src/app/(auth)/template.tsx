/**
 * The same screen fade the staff and portal groups use, on the way in.
 *
 * Sign-in, the second-factor step and sign-up are separate segments, so each one is a
 * remount and each one settles in instead of swapping. A template rather than the layout,
 * because only a template is remounted when the segment beneath it changes — see the staff
 * template for the longer note.
 *
 * Decoration, and a Server Component with no state: it adds one class and ships no
 * JavaScript. Removing it changes nothing but the movement.
 */
export default function AuthTemplate({ children }: { children: React.ReactNode }) {
  /*
   * The wrapper repeats the group layout's centring rather than inheriting it. A plain
   * <div> here would become the centred grid item itself, and the card inside — which is
   * `width: 100%` up to a maximum — would collapse to the width of its own text.
   */
  return (
    <div className="cq-screen" style={{ width: '100%', display: 'grid', placeItems: 'center' }}>
      {children}
    </div>
  );
}
