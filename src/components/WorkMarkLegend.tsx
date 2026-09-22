// What the marks on a tab mean, in one place.
//
// Two surfaces show this: the welcome wizard's hooks step (where the marks
// are about to start appearing and nobody has seen one yet) and Settings ->
// Notifications (under the two toggles that gate them, because "what is that
// dot" gets asked in the same breath as "can I turn it off").
//
// Drawn with the REAL badge component rather than described or redrawn, so
// they are live: the spinner spins and the ring drifts at the speeds they
// actually run at, which is half of what tells the two apart. It also means
// the legend cannot fall out of step with the app. Changing a mark changes
// this with it, and `settings.e2e.ts` fails if the row set stops matching.
//
// A tooltip was not enough on its own. The badge sits in a slot that the
// close button and the row's kebab take over on hover, so the mark cannot be
// pointed at; and a small round outline is not a thing anyone guesses.

import { TaskWorkBadge } from "@/components/TaskWorkBadge";
import type { DelegatedWork } from "@/lib/delegatedWork";

const HELD: DelegatedWork = { label: "shell", count: 1, ids: [] };

/** One row per state a tab can report. Order is the precedence chain, least
 *  urgent first, so it reads as an escalation. */
export const WORK_MARKS: Array<{ key: string; badge: React.ReactNode; what: string }> = [
  {
    key: "working",
    badge: <TaskWorkBadge reason="working" />,
    what: "The agent is working right now.",
  },
  {
    key: "delegated",
    badge: <TaskWorkBadge reason="delegated" delegated={HELD} />,
    what: "Waiting on subagents or scripts it started. Nothing is being computed, and this can last hours.",
  },
  {
    key: "partial",
    badge: <TaskWorkBadge reason="working" delegated={{ ...HELD, partial: true }} preview />,
    what: "Partially done. Some of that work came back, the rest is still running.",
  },
  {
    key: "done",
    badge: <TaskWorkBadge reason="done" />,
    what: "Work done.",
  },
  {
    key: "attention",
    badge: <TaskWorkBadge reason="attention" />,
    what: "Needs your attention: a permission prompt, a question, or anything else it cannot get past on its own.",
  },
];

export function WorkMarkLegend({ className }: { className?: string }) {
  return (
    <div className={className} data-testid="work-mark-legend">
      <div className="flex flex-col gap-2">
        {WORK_MARKS.map(({ key, badge, what }) => (
          <div key={key} className="flex items-start gap-2.5">
            <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
              {badge}
            </span>
            <span className="text-[12.5px] leading-snug text-[var(--color-fg-dim)]">
              {what}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
