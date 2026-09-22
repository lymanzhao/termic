// The agent-working spinner: a model is generating RIGHT NOW. Its quiet
// counterpart is `BackgroundRing`, for an agent that has stopped and is
// waiting on something it delegated.
//
// SVG, and a 2px stroke, and both are corrections to the CSS version this
// replaces. That one was a `border-radius` ring with a `border-[1.5px]`:
// 1.5px is exactly 3 device pixels at 2x and lands on a HALF pixel at 1x, so
// the same mark came out crisp on a retina display and thin and smeared on
// anything else. 2px is whole-pixel at both. Reported as the indicator being
// thicker on retina, which it was.
//
// Two circles, not a three-quarter arc. The old one hid a quarter of the
// ring by making `border-top` transparent, which reads as a ring with a bite
// out of it; a faint full track under a brighter arc reads as one object
// with a highlight travelling round it. Same information, and it no longer
// looks broken when it stops.
//
// Both circles are drawn from `currentColor`, so a caller sets the colour
// once and the track follows it. No hex anywhere: themes override the token.
//
// Keep `size` EVEN. An odd box centres on a half pixel by definition, which
// is the wobble the CSS version documented and this one inherits: the
// rotation is about the box centre either way.

const STROKE = 2;
/** How much of the ring the bright arc covers. A third is enough to read as
 *  a direction of travel without closing the ring up. */
const ARC = 0.33;
/** The track behind it. Low enough to read as a groove rather than a second
 *  mark, high enough to survive a dim theme. */
const TRACK_OPACITY = 0.25;

export function Spinner({
  size = 12,
  className,
}: {
  /** Outer diameter in px. Even numbers only (see above). */
  size?: number;
  /** Applied to the svg. Colour comes from `currentColor`. */
  className?: string;
}) {
  // Inset by half the stroke so the ring is drawn INSIDE the box.
  const r = (size - STROKE) / 2;
  const c = 2 * Math.PI * r;
  // A round cap adds half the stroke at each end, so the painted arc is
  // `dash + STROKE`. Subtract it or the arc overshoots what was asked for.
  const dash = Math.max(0.01, c * ARC - STROKE);
  return (
    <svg
      aria-hidden
      data-mark="spinner"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={`termic-spin block shrink-0 ${className ?? ""}`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
        opacity={TRACK_OPACITY}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${c - dash}`}
      />
    </svg>
  );
}
