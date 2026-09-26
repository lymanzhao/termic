// Which task spawned which: the pure half of the sidebar's spawn links. A task
// an agent creates through the CLI or MCP carries `spawned_by` (its parent's
// id) whether or not the two share a group, which is what links a child in
// ANOTHER project, where a group cannot (see Rust `apply_spawn_link`).

import type { Task } from "@/lib/types";

/** The parent a row's "started by" mark points at, or null when it draws
 *  none: no live parent, or the two sit in one drawn group, whose rail
 *  already says it. A legacy group spanning projects (drawn as plain rows,
 *  `crossProjectStrays`) needs no special case: its parent is in another
 *  project, which already means a mark. */
export function spawnMarkParent(task: Task, tasks: Task[]): Task | null {
  if (!task.spawned_by) return null;
  const parent = tasks.find(t => t.id === task.spawned_by && !t.archived);
  if (!parent) return null;
  return inOneBlock(parent, task) ? null : parent;
}

/** Both rows sit in one drawn group block, whose rail already links them. */
const inOneBlock = (a: Task, b: Task) =>
  a.project_id === b.project_id && !!a.group && a.group.id === b.group?.id;

/** The links to draw while `hoveredId`'s row is hovered, as [parent, child]
 *  ids: up to its own parent, and down to every task it spawned. One level
 *  each way, so hovering an orchestrator shows exactly its workers and never
 *  a whole tree across the sidebar. Archived tasks have no row to point at,
 *  and a pair in one group block gets no line: the rail already says it. */
export function spawnLinkPairs(hoveredId: string, tasks: Task[]): [string, string][] {
  const live = tasks.filter(t => !t.archived);
  const me = live.find(t => t.id === hoveredId);
  if (!me) return [];
  const out: [string, string][] = [];
  const parent = me.spawned_by ? live.find(t => t.id === me.spawned_by) : undefined;
  if (parent && !inOneBlock(parent, me)) out.push([parent.id, me.id]);
  for (const t of live) if (t.spawned_by === me.id && !inOneBlock(me, t)) out.push([me.id, t.id]);
  return out;
}
