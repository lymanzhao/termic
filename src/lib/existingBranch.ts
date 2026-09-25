// Checking out an EXISTING branch into a new worktree task (New Task's
// "Existing branch" mode, `termic new --checkout`): the rows the picker shows
// and the task name a branch suggests.
//
// Rust does the actual resolution (`checkout_existing_branch` in lib.rs): a
// local branch wins, a remote-only one is fetched and tracked, and an unknown
// name is an error rather than a fresh branch. Nothing here decides that.

import type { BranchContext } from "@/lib/types";

/** Most rows the picker renders at once. A big repo carries thousands of
 *  remote-tracking refs and each row is a button; past this many, typing
 *  narrows the list faster than scrolling finds a row. */
export const BRANCH_CHOICES_MAX = 100;

export interface BranchChoice {
  /** What goes to Rust: a local branch name, or `<remote>/<branch>`. */
  ref: string;
  /** "local", or the remote the ref lives on ("origin"). */
  source: string;
}

/** The remotes a context's remote-tracking refs live on, first seen first. */
export function remoteNames(ctx: BranchContext): string[] {
  const out = new Set<string>();
  for (const r of ctx.remote) {
    const i = r.indexOf("/");
    if (i > 0) out.add(r.slice(0, i));
  }
  return [...out];
}

/** Local branches first, then remote ones, filtered by a case-insensitive
 *  substring of `query`. A remote branch whose name is already local is left
 *  out: checking out either one lands on the local branch (it may hold your
 *  own commits, so Rust never moves it), and two rows for one outcome only
 *  make the user wonder which to pick. */
export function branchChoices(
  ctx: BranchContext,
  query: string,
): { choices: BranchChoice[]; truncated: boolean } {
  const local = new Set(ctx.local);
  const all: BranchChoice[] = [
    ...ctx.local.map(ref => ({ ref, source: "local" })),
    ...ctx.remote.flatMap(ref => {
      const i = ref.indexOf("/");
      if (i <= 0 || local.has(ref.slice(i + 1))) return [];
      return [{ ref, source: ref.slice(0, i) }];
    }),
  ];
  const q = query.trim().toLowerCase();
  const hits = q ? all.filter(c => c.ref.toLowerCase().includes(q)) : all;
  return { choices: hits.slice(0, BRANCH_CHOICES_MAX), truncated: hits.length > BRANCH_CHOICES_MAX };
}

/** Whether the repo already has a ref for `value`, as typed or under one of
 *  its remotes. False means Rust will have to fetch it on create, which is
 *  worth saying before the user presses Create. */
export function isKnownBranch(ctx: BranchContext, value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (ctx.local.includes(v) || ctx.remote.includes(v)) return true;
  return remoteNames(ctx).some(r => ctx.remote.includes(`${r}/${v}`));
}

/** The task name a checked-out branch suggests: the branch itself minus its
 *  remote, so `origin/alice/fix` and `alice/fix` name the same task (and the
 *  same `alice-fix` worktree folder). */
export function checkoutTaskName(ref: string, remotes: string[]): string {
  const r = ref.trim();
  const i = r.indexOf("/");
  if (i > 0 && i < r.length - 1 && remotes.includes(r.slice(0, i))) return r.slice(i + 1);
  return r;
}
