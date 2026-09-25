// Per-project task filter for the sidebar (GH #324): a bell that keeps only
// tasks with a notification, and a text match on the task name and its
// agent tabs' titles. Pure functions of store state, evaluated at render, so
// a CLI rename or a notification arriving shows or hides a row with no extra
// wiring.

import type { Agent, Tab, Task, TerminalTab } from "@/lib/types";
import { agentDisplayName } from "@/lib/agents";
import { aggregateTabsState } from "@/lib/cliAgentState";

export interface TaskFilter {
  /** Raw input value; matching trims it. */
  text: string;
  bell: boolean;
}

export function isFilterActive(f: TaskFilter | undefined): f is TaskFilter {
  return !!f && (f.bell || f.text.trim() !== "");
}

/** Same classification as the tray's numeral (computeTrayAttention):
 *  a task counts when its aggregate is "waiting" or "done". A task whose
 *  tabs were never loaded this session has no signal, so it never counts. */
export function taskHasNotification(tabs: Tab[] | undefined): boolean {
  const term = (tabs ?? []).filter((t): t is TerminalTab => t.type === "terminal");
  if (term.length === 0) return false;
  const st = aggregateTabsState(term);
  return st === "waiting" || st === "done";
}

/** The STABLE titles of a task's terminal tabs: the user's rename, else the
 *  default title. `liveTitle` (the agent's OSC title) is deliberately left
 *  out: agents rewrite it every second ("thinking...", spinners), and
 *  matching on it would make rows flap in and out of the list. A task whose
 *  tabs are not loaded yet falls back to its persisted tabs, titled the way
 *  a restore would title them. */
function tabTitles(task: Task, tabs: Tab[] | undefined, agents: Agent[]): string[] {
  if (tabs) {
    return tabs.filter((t): t is TerminalTab => t.type === "terminal").map(t => t.title);
  }
  return (task.persisted_tabs ?? []).map(pt =>
    pt.custom_title && pt.title ? pt.title : agentDisplayName(pt.cli, agents));
}

export function taskMatchesText(task: Task, tabs: Tab[] | undefined, agents: Agent[], text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (!needle) return true;
  if (task.name.toLowerCase().includes(needle)) return true;
  return tabTitles(task, tabs, agents).some(t => t.toLowerCase().includes(needle));
}

/** Tasks that pass `filter` (both parts AND). The active task always stays:
 *  opening a task clears its notification, and without the exemption the
 *  row the user just clicked would vanish from under the cursor. It drops
 *  out once another task is selected. */
export function filterTasks(
  list: Task[],
  filter: TaskFilter | undefined,
  tabs: Record<string, Tab[] | undefined>,
  agents: Agent[],
  activeTaskId: string | null,
): Task[] {
  if (!isFilterActive(filter)) return list;
  return list.filter(t =>
    t.id === activeTaskId
    || ((!filter.bell || taskHasNotification(tabs[t.id]))
      && taskMatchesText(t, tabs[t.id], agents, filter.text)));
}
