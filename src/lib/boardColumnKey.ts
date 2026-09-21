// BoardView's column-assignment selector body.
//
// Split out of taskBoardState.ts on purpose: this selector reads BOTH stores
// (app state in, pr snapshot via getState), and the pr import chain touches
// the DOM at module scope (store/prefs applies the theme on load). The pure
// derivation's unit test must not need a DOM, so the impure edge lives here.
//
// Exported (rather than inlined in BoardView) so selectorFanout.test.ts
// measures the REAL selector, the discipline selectTaskTabs already follows
// in store/app.ts.
//
// Two deliberate shape choices:
//
//   - The result is ONE STRING, not a record or array. Object.is on a string
//     is a value compare, so no useShallow is needed and a per-keystroke tab
//     write that moves no badge produces the identical string: the board
//     re-renders when a task changes COLUMN, and only then.
//   - The PR snapshot is read non-reactively from the pr store. App-store
//     notifications re-run this selector, but a pr-store write does not, so
//     BoardView ALSO holds a tiny usePr subscription purely as a re-render
//     trigger; useSyncExternalStore re-reads this snapshot on that render and
//     picks the new column up. One trigger, one derivation, no duplicated
//     precedence logic.

import { EMPTY_TABS, type AppState } from "@/store/app";
import { usePr } from "@/store/pr";
import { taskBoardColumn } from "./taskBoardState";
import type { WorkStatePrefs } from "./taskWorkState";

export const selectBoardColumnKey =
  (prefs: WorkStatePrefs) => (s: AppState): string => {
    const pr = usePr.getState().byTask;
    return s.tasks
      .map(w => `${w.id}:${taskBoardColumn(w, s.tabs[w.id] ?? EMPTY_TABS, pr[w.id]?.lookup ?? null, prefs)}`)
      .join("|");
  };
