// Matching a file-path fragment from terminal output against the workspace
// file list, on segment boundaries (not raw string suffix).
import { relUnder } from "./osPath";

export function normalizePath(p: string): string {
  // Strip every leading "./" and "/" (but not "../", which is meaningful).
  return p.replace(/^(?:\.?\/)+/, "");
}

export function matchesSuffix(candidate: string, clicked: string): boolean {
  const c = normalizePath(candidate);
  const q = normalizePath(clicked);
  return c === q || c.endsWith("/" + q);
}

export function resolvePathClick(files: string[], clicked: string): string[] {
  return files.filter(f => matchesSuffix(f, clicked));
}

// ─────────────────────── absolute paths (GH #240) ───────────────────────
//
// Everything above resolves a FRAGMENT ("did the agent mean this file?").
// An absolute path is not a fragment: it says exactly where it lives, so it
// gets resolved rather than matched. Doing that here (a pure function over
// roots the frontend already holds) keeps it unit-testable and adds no IPC.

/** A directory whose contents are reachable as task-relative paths. */
export interface TaskRoot {
  /** Absolute path on disk. */
  path: string;
  /** Task-relative prefix that files under `path` resolve to: "" for the task
   *  root itself, the member's `dir_name` for a composition member. Mirrors
   *  `resolve_task_git_path_ex` on the Rust side, which maps `<dir_name>/rest`
   *  back onto that member's own repo. */
  prefix: string;
}

/** Expand a leading `~`. Returns `p` unchanged when `home` is unknown, so a
 *  failed `homeDir()` degrades to "treat it as outside the task" rather than
 *  building a bogus path out of an empty string. */
export function expandTilde(p: string, home: string): string {
  if (!home) return p;
  if (p === "~") return home;
  return p.startsWith("~/") ? home + p.slice(1) : p;
}

/** The inverse: shorten an absolute path under `home` to a `~/` one. For
 *  display only, and unchanged when `home` is unknown or the path lies
 *  outside it, so the worst case is the full path rather than a wrong one. */
export function tildePath(p: string, home: string): string {
  if (!home) return p;
  if (p === home) return "~";
  return p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

export type AbsoluteClick =
  | { kind: "inside"; rel: string }
  | { kind: "outside"; abs: string };

/** Map an absolute path onto a task-relative one, or report it as outside.
 *
 *  Never falls back to suffix matching: an absolute path that lands outside
 *  every root is OUTSIDE, not a hint to go hunting for a similarly-named file
 *  in the task. That distinction is the GH #240 wrong-file fix. */
export function resolveAbsoluteClick(abs: string, roots: TaskRoot[]): AbsoluteClick {
  // Longest root first. A composition member checked out UNDER the task root
  // must win over the task root itself, or its files resolve to the wrapper
  // and read from the wrong repo.
  const ordered = roots
    .filter(r => r.path)
    .map(r => ({ ...r, path: r.path.replace(/\/+$/, "") }))
    .sort((a, b) => b.path.length - a.path.length);
  for (const r of ordered) {
    // Segment boundary, not raw prefix: `/repo-old/a.ts` must not resolve
    // against a root of `/repo`.
    // (relUnder: on Windows also either separator and any case.)
    const rest = abs === r.path ? "" : relUnder(abs, r.path);
    if (rest === null) continue;
    const rel = r.prefix ? (rest ? `${r.prefix}/${rest}` : r.prefix) : rest;
    // The root directory itself is not a file to open; let it read as outside
    // so the menu offers Reveal instead of opening an empty editor tab.
    if (!rel) continue;
    return { kind: "inside", rel };
  }
  return { kind: "outside", abs };
}
