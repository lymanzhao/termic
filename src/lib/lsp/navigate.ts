// One way to arrive somewhere, so one place records the trail (GH #174).
//
// Every navigation in this subsystem — go to definition, a usage from the
// popup, a symbol from the search, an entry in the file outline — lands here.
// That is what makes Back work: the history is written at the single point
// where a jump actually happens, rather than at each of the four callers, one
// of which would eventually forget.

import type { EditorView } from "@codemirror/view";
import { LSPPlugin } from "@codemirror/lsp-client";
import { useApp } from "@/store/app";
import { useNavHistory, type NavPoint } from "@/store/navHistory";
import { gotoLocation } from "@/lib/gotoLocation";
import { uriToPath } from "./workspace";
import { relUnder } from "@/lib/osPath";

/**
 * Which task owns a file on disk.
 *
 * The ACTIVE task first, deliberately: several tasks can run in one main
 * checkout, so `tasks.find(path matches)` picks whichever was created first
 * and navigation would yank the user into a different task's pane — with the
 * one they were reading hidden behind it.
 */
export function taskForPath(abs: string) {
  const app = useApp.getState();
  const active = app.tasks.find(t => t.id === app.activeTaskId);
  if (active && relUnder(abs, active.path) !== null) return active;
  return app.tasks.find(t => relUnder(abs, t.path) !== null) ?? active ?? null;
}

/** Where the cursor is right now, as a point the history can return to. */
export function currentPoint(view: EditorView): NavPoint | null {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return null;
  const abs = uriToPath(plugin.uri);
  if (!abs) return null;
  const task = taskForPath(abs);
  if (!task) return null;
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return pointFor(task.id, task.path, abs, line.number, head - line.from + 1);
}

/** A point, deciding for itself whether the file is inside the task. */
export function pointFor(
  taskId: string,
  taskPath: string,
  abs: string,
  line: number,
  col?: number,
): NavPoint {
  const rel = relUnder(abs, taskPath);
  return {
    taskId,
    path: rel ?? abs,
    external: rel === null,
    line,
    col,
  };
}

/**
 * Go to a place, recording the trip.
 *
 * `from` is where the reader was standing; passing it is what makes Back
 * return to the call site rather than to the previous definition.
 */
export async function navigateTo(
  view: EditorView | null,
  target: NavPoint,
  from: NavPoint | null,
): Promise<void> {
  useNavHistory.getState().push(from, target);
  await open(view, target);
}

/** Replay a point without recording it: Back and Forward move THROUGH the
 *  history, they do not extend it. */
export async function replay(view: EditorView | null, point: NavPoint): Promise<void> {
  await open(view, point);
}

async function open(view: EditorView | null, target: NavPoint): Promise<void> {
  const app = useApp.getState();
  const task = app.tasks.find(t => t.id === target.taskId);
  if (!task) return;

  // Already looking at it: move the cursor and skip the tab machinery, which
  // is the common case for a jump inside one file.
  if (view) {
    const plugin = LSPPlugin.get(view);
    const abs = target.external ? target.path : `${task.path}/${target.path}`;
    if (plugin && uriToPath(plugin.uri) === abs) {
      gotoLocation(view, target.line, target.col);
      return;
    }
  }

  // A different file: the tab layer owns opening one, and `revealAt` is the
  // existing mechanism for "open it and land on this line" (Find-in-Files
  // uses the same one).
  if (app.activeTaskId !== target.taskId) app.setActiveTask(target.taskId);
  app.openPreviewTab(target.taskId, {
    type: target.external ? "external" : "edit",
    path: target.path,
    title: target.path.split("/").pop() ?? target.path,
    revealAt: { line: target.line, col: target.col },
  });
}

/** Back / Forward. Returns false when there is nowhere to go, so a keymap can
 *  let the key through to whatever else wants it. */
export async function goBack(view: EditorView | null): Promise<boolean> {
  const point = useNavHistory.getState().back();
  if (!point) return false;
  await replay(view, point);
  return true;
}

export async function goForward(view: EditorView | null): Promise<boolean> {
  const point = useNavHistory.getState().forward();
  if (!point) return false;
  await replay(view, point);
  return true;
}
