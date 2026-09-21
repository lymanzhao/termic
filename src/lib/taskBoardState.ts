// Board view: which column a task's card sits in, and which swimlanes exist.
//
// The third consumer of taskWorkState.ts (after Sidebar and Dashboard),
// documented in docs/ui.md "Board view". The columns are DERIVED, never stored: the
// terminal is the ground truth, so a card can never drift from what the agent
// is actually doing (no `status` field on Task, by design).
//
// Kept pure and hook-free so the precedence matrix is unit-testable without
// mounting the board, and so BoardView stays a thin renderer over this file.

import type { Agent, Tab, Task } from "./types";
import {
  taskNeedsAttention,
  taskWorking,
  type WorkStatePrefs,
} from "./taskWorkState";

/** The columns, in display order. "archived" is rendered separately (it spans
 *  the full board width, ignoring swimlanes) but is part of the same
 *  derivation so the override-everything rule lives in exactly one place. */
export type BoardColumn = "attention" | "working" | "review" | "settled" | "archived";

export const BOARD_STATE_COLUMNS = ["attention", "working", "review", "settled"] as const;
export type BoardStateColumn = (typeof BOARD_STATE_COLUMNS)[number];

/** The slice of the live PR snapshot the review column needs. Matches
 *  `PrLookup` in types.ts structurally so callers can pass the `usePr` entry's
 *  lookup straight in without this module importing the store. */
export interface BoardPrInfo {
  pr: { state: string | null } | null;
}

/** Which column a task belongs in. Precedence, top wins:
 *
 *    archived          -> archived        (overrides everything)
 *    needs attention   -> attention       (agent blocked on the user)
 *    working           -> working         (agent mid-turn)
 *    PR open or draft  -> review          (main checkouts never poll PRs)
 *    everything else   -> settled         (includes freshly spawned tasks:
 *                                          termic has no not-started state)
 *
 *  A merged or closed PR falls THROUGH to settled: the review column answers
 *  "waiting on a reviewer", and a merged PR is not. An unfetched PR (lookup
 *  null) counts as review while its identity is persisted — the poller will
 *  resolve it shortly, and a card that flickers settled -> review on every
 *  board open is worse than a briefly optimistic column. */
export function taskBoardColumn(
  task: Task,
  tabs: Tab[],
  pr: BoardPrInfo | null | undefined,
  prefs: WorkStatePrefs,
): BoardColumn {
  if (task.archived) return "archived";
  if (taskNeedsAttention(tabs, prefs)) return "attention";
  if (taskWorking(tabs, prefs)) return "working";
  // Same gate as `pollableTasks` in store/pr.ts: identity persisted on the
  // task, and never for a main checkout (nothing polls those, so a stale
  // pr_url there would pin the card in review forever).
  if (!task.is_main_checkout && (task.pr_url || task.pr_number != null)) {
    const state = pr?.pr?.state ?? null;
    if (state === null || state === "open" || state === "draft") return "review";
  }
  return "settled";
}

/** Swimlane order: the agent registry's order first (built-ins lead, and a
 *  user who reordered their agents sees the same order here), then any cli id
 *  the registry does not know (a task outliving a deleted custom agent),
 *  alphabetical. Only lanes with at least one live task exist at all — an
 *  empty swimlane is height spent on nothing. */
export function boardLanes(tasks: Task[], agents: Agent[]): string[] {
  const present = new Set(tasks.filter(t => !t.archived).map(t => t.cli));
  const known = agents.map(a => a.id).filter(id => present.has(id));
  const unknown = [...present].filter(id => !agents.some(a => a.id === id)).sort();
  return [...known, ...unknown];
}

/** Stable ordering inside one cell: cards are grouped by project (project
 *  array order), and within a project they keep the store's task order —
 *  the same order the sidebar shows, which Rust sorts on the manual drag
 *  `order` then `created`. Reordering inside a group is the ONLY reorder the
 *  board allows, because `task_reorder`'s contract is same-project ids. */
export function boardCellGroups(cellTasks: Task[], projectOrder: string[]): { projectId: string; tasks: Task[] }[] {
  const byProject = new Map<string, Task[]>();
  for (const t of cellTasks) {
    const list = byProject.get(t.project_id);
    if (list) list.push(t);
    else byProject.set(t.project_id, [t]);
  }
  return [...byProject.entries()]
    .map(([projectId, tasks]) => ({ projectId, tasks }))
    .sort((a, b) => {
      const ai = projectOrder.indexOf(a.projectId);
      const bi = projectOrder.indexOf(b.projectId);
      // Unknown project (deleted mid-session): sink to the bottom, keep
      // relative order stable.
      return (ai === -1 ? projectOrder.length : ai) - (bi === -1 ? projectOrder.length : bi);
    });
}
