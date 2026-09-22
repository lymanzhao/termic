// How the task footer's usage chips behave when a task runs more agents than
// the bar can hold.
//
// Reported with five agents in one task: the chips ran past the end of the bar
// and under the right panel. The bar had exactly one shedding rule, hide a
// secondary agent's whole chip below 780px, and that width was measured for
// the TWO-agent case, so with five the chips wanted ~870px on their own and it
// never fired.
//
// A chip is now either FULLY shown or not shown at all. There is no abbreviated
// middle state: a chip missing its plan figures reads identically to an agent
// that has none, which is the footer lying by omission, and half a readout in a
// bar you are meant to take at a glance is worth less than a clear count of
// what is missing.
//
// The breakpoints are CSS container queries on the footer's own `@container`,
// NOT a ResizeObserver, which is a deliberate constraint rather than an
// oversight: this bar sits under a streaming terminal, and measuring it in JS
// would put a React render on every window drag (see the `@container` note in
// TerminalPane). The cost of that choice is that the overflow marker cannot
// carry a NUMBER, because nothing here knows how many chips actually fit. It
// says "there are more", which is the honest thing CSS can express.

/** Width a full chip needs, gap included. Measured in the e2e window: a chip
 *  with both plan windows and no account name renders at 174px, and the strip
 *  puts 6px between them. */
const CHIP_W = 180;

/** What the bar owes everything that is not a secondary chip: the queue and
 *  Terminal controls on the left (~214px with their labels), the ACTIVE
 *  agent's chip (~174px, never hidden), the sandbox status pinned right
 *  (~92px), and the overflow marker (~28px). */
const BAR_CHROME_W = 508;

// Tailwind needs these as literal strings, so the table is written out rather
// than computed: `BAR_CHROME_W + CHIP_W * k`, k = 1..8. Past the table's end
// the last entry repeats, so a task with a truly silly number of agents drops
// the tail together instead of one at a time. The constants above are what to
// edit if the chip's width changes; keep the two tables in step with them.

/** Hide the k-th secondary chip (1-based) below the width at which it stops
 *  fitting, so the bar sheds from the tail as it narrows. */
const SECONDARY_HIDE = [
  "@max-[688px]:hidden",
  "@max-[868px]:hidden",
  "@max-[1048px]:hidden",
  "@max-[1228px]:hidden",
  "@max-[1408px]:hidden",
  "@max-[1588px]:hidden",
  "@max-[1768px]:hidden",
  "@max-[1948px]:hidden",
] as const;

/** Hide the overflow marker ABOVE the width at which the last secondary chip
 *  fits, i.e. show it exactly while at least one chip is missing. */
const MORE_HIDE = [
  "@min-[688px]:hidden",
  "@min-[868px]:hidden",
  "@min-[1048px]:hidden",
  "@min-[1228px]:hidden",
  "@min-[1408px]:hidden",
  "@min-[1588px]:hidden",
  "@min-[1768px]:hidden",
  "@min-[1948px]:hidden",
] as const;

const at = (table: readonly string[], k: number) => table[Math.min(k, table.length - 1)]!;

/** Every agent the task runs, minus the one whose tab is on screen, in the
 *  order the footer renders them. The active agent is never in here: its chip
 *  is the one the user is looking at and it is never hidden, at any width. */
function secondaries(agentIds: readonly string[], activeAgent: string | undefined): string[] {
  return agentIds.filter(id => id !== activeAgent);
}

/** How `id`'s chip renders. `hideClass` is undefined for the active agent (and
 *  for a single-agent task), which is what pins it on screen. */
export function footerChipMode(agentIds: readonly string[], activeAgent: string | undefined, id: string): {
  secondary: boolean;
  hideClass: string | undefined;
} {
  if (agentIds.length <= 1 || id === activeAgent) return { secondary: false, hideClass: undefined };
  const k = secondaries(agentIds, activeAgent).indexOf(id);
  // Not among them (a render between a tab closing and the list settling):
  // show it rather than guess at a breakpoint for a chip that is on its way
  // out. A stale chip for one frame beats a flicker in the ones beside it.
  if (k < 0) return { secondary: true, hideClass: undefined };
  return { secondary: true, hideClass: at(SECONDARY_HIDE, k) };
}

/** The class for the "there are more" marker, or null when the task cannot
 *  hide anything (one agent, so nothing is ever dropped). The marker is in the
 *  DOM whenever there is a secondary chip and CSS decides whether it shows,
 *  which is what keeps the decision off the JS side entirely. */
export function moreMarkerClass(agentIds: readonly string[], activeAgent: string | undefined): string | null {
  const n = secondaries(agentIds, activeAgent).length;
  if (n < 1) return null;
  return at(MORE_HIDE, n - 1);
}
