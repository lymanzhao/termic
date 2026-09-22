// The BACKGROUND-WORK ring: the agent's own loop has stopped and it is waiting
// on something it delegated (a subagent, a shell it left running). See
// `lib/delegatedWork.ts` and docs/agent-states.md.
//
// Deliberately not the working `Spinner`, and the difference is the point. A
// spinner turning once a second means "a model is computing right now", and
// it is the wrong claim twice over: nothing is being computed, and the state
// can last for hours (a monitoring agent), where a fast spinner reads as a
// hang. This one is a broken ring turning once every 8 seconds: alive, not
// busy. The speed, and why it turns rather than pulses when several are on
// screen at once, are argued in `index.css`.
//
// SVG, and NOT a CSS `border-dotted` circle, which is what this was first.
// WebKit paints a border one side at a time, so the dot pattern restarts at
// each of the four side boundaries: the dots come out unevenly spaced, with a
// doubled or missing one where the sides meet, and no stroke width or
// diameter fixes it. Reported as "it looks like a dot is missing", which is
// exactly what it was.
//
// Here the spacing is exact by construction: the dash period divides the
// circumference a whole number of times, so the pattern closes on itself with
// no seam. `0.01` with a round cap is the standard way to draw a dot rather
// than a dash, and its painted diameter is the stroke width.
//
// Weight is 2, against the spinner's 1.5, and that is not a mismatch: a ring
// that is mostly gaps reads lighter than a solid arc at the same width, so
// matching the number would not match the weight.

const DASHES = 8;
const STROKE = 2;
/** The VISIBLE gap, in px, and the dash is whatever is left of the period.
 *
 *  Specified this way round because the gap is the thing the eye judges and
 *  the thing at risk: as a fraction of the period it changes with the
 *  diameter, and this mark is drawn at two of them. A ratio that looked
 *  dashed at 14px came out sparse at 12px, and the reverse.
 *
 *  1.6px is a floor as much as a choice. Dash ends land at fractional
 *  positions around a curve no matter what, so every edge is antialiased;
 *  what matters is that the gap stays wide enough to survive it. Below
 *  ~1.5px a gap is one part-lit pixel on a 1x display and the ring closes up
 *  into a continuous circle, which is the failure this already had once. */
const GAP = 1.6;

export function BackgroundRing({
  size = 12,
  className,
}: {
  /** Outer diameter in px. Even numbers only: an odd box centres on a half
   *  pixel, which is the wobble `Spinner` documents. */
  size?: number;
  /** Applied to the svg. Colour comes from `currentColor`. */
  className?: string;
}) {
  // Inset by half the stroke so the ring is drawn INSIDE the box, the way a
  // border is, rather than being clipped at the viewBox edge.
  const r = (size - STROKE) / 2;
  // The PATTERN length is dash + gap, so the two must SUM to the period. A
  // dash plus a separate gap that do not sum to it puts the seam back.
  const period = (2 * Math.PI * r) / DASHES;
  // A ROUND cap extends each dash by half the stroke at BOTH ends, so the
  // painted dash is `dash + STROKE` and the gap loses the same amount.
  // Handing over a length without subtracting the caps paints 4.6 of a 4.7
  // period: a continuous circle with hairline nicks in it, which is what it
  // looked like. So the caps come out first, and what is asked for is the
  // GAP.
  const dash = Math.max(0.01, period - GAP - STROKE);
  return (
    <svg
      aria-hidden
      data-mark="background"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={`termic-drift block shrink-0 ${className ?? ""}`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${period - dash}`}
      />
    </svg>
  );
}
