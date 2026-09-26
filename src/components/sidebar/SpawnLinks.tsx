// Spawn links in the sidebar: which task's agent started which. Two pieces,
// both drawn from `Task.spawned_by` (rules in src/lib/spawnLinks.ts):
//
// - `SpawnedFromMark`, a small ↳ on a child's row naming its parent, for a
//   child the group rail does not already explain (another project, or
//   dragged out of the group). A click goes to the parent.
// - `SpawnLinksOverlay`, lines between a hovered row and its parent and
//   children. Only on hover: drawn all the time, links between rows that sit
//   far apart (and cross other projects) would tangle the list.

import { useEffect, useRef, useState, type RefObject } from "react";
import { CornerDownRight } from "lucide-react";
import { useApp } from "@/store/app";
import { spawnLinkPairs, spawnMarkParent } from "@/lib/spawnLinks";
import type { Task } from "@/lib/types";

export function SpawnedFromMark({ task }: { task: Task }) {
  // One string, so the row re-renders when the PARENT's label changes, not
  // on every store write (docs/performance.md, selector fanout).
  const key = useApp(s => {
    const p = spawnMarkParent(task, s.tasks);
    if (!p) return "";
    const project = p.project_id === task.project_id ? "" : s.projects.find(x => x.id === p.project_id)?.name ?? "";
    return `${p.id}\u0000${p.name}\u0000${project}`;
  });
  if (!key) return null;
  const [parentId, name, project] = key.split("\u0000");
  const label = project ? `${name} (${project})` : name;
  return (
    // A plain `title` like the row's name: a Radix Tip per row would add a
    // provider each and its own pointer handlers in front of the row's drag.
    <button
      type="button"
      data-no-drag
      data-testid={`task-spawned-from-${task.id}`}
      data-parent-id={parentId}
      title={`Started by ${label}. Click to go there.`}
      aria-label={`Started by ${label}`}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => {
        e.stopPropagation();
        useApp.getState().setActiveTask(parentId);
      }}
      className="shrink-0 rounded p-px text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
    >
      <CornerDownRight className="h-3 w-3" />
    </button>
  );
}

type Line = { key: string; d: string; x: number; y: number };

/** Where the lines run: this far in from the list's left edge, clear of it
 *  and still left of every row (loose task rows start 20px in, grouped ones
 *  further). Hugging the edge read as a border, not a link. */
const TRUNK_X = 12;
/** Corner radius of each elbow. */
const R = 4;

/** An elbow from the parent's row down (or up) the trunk to the child's row,
 *  both ends at the row's left edge and vertical middle. */
function elbow(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const dir = to.y > from.y ? 1 : -1;
  const r = Math.min(R, Math.abs(to.y - from.y) / 2);
  return [
    `M ${from.x} ${from.y}`,
    `H ${TRUNK_X + r}`,
    `Q ${TRUNK_X} ${from.y} ${TRUNK_X} ${from.y + dir * r}`,
    `V ${to.y - dir * r}`,
    `Q ${TRUNK_X} ${to.y} ${TRUNK_X + r} ${to.y}`,
    `H ${to.x}`,
  ].join(" ");
}

/** Mounted inside the scrolling project list (which must be `relative`), so
 *  the lines scroll with the rows. Holds its own hover state and reads the
 *  task list only when the hovered row changes: hovering never re-renders
 *  the Sidebar, and a store write never re-renders this. */
export function SpawnLinksOverlay({ containerRef }: { containerRef: RefObject<HTMLElement | null> }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [height, setHeight] = useState(0);
  const hovered = useRef<string | null>(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const show = (id: string | null) => {
      if (id === hovered.current) return;
      hovered.current = id;
      const pairs = id ? spawnLinkPairs(id, useApp.getState().tasks) : [];
      if (pairs.length === 0) { setLines(prev => (prev.length ? [] : prev)); return; }
      const box = root.getBoundingClientRect();
      const at = (taskId: string) => {
        // The header row, not the wrapper: an expanded task's wrapper spans
        // its tab rows too, and the link belongs to the row with the name.
        const el = root.querySelector<HTMLElement>(`[data-sidebar-task-id="${CSS.escape(taskId)}"]`);
        if (!el) return null; // collapsed, filtered out, or scrolled away in a closed project
        const r = el.getBoundingClientRect();
        return { x: r.left - box.left + root.scrollLeft, y: r.top - box.top + root.scrollTop + r.height / 2 };
      };
      const next: Line[] = [];
      for (const [p, c] of pairs) {
        const a = at(p), b = at(c);
        if (a && b) next.push({ key: `${p}>${c}`, d: elbow(a, b), x: b.x, y: b.y });
      }
      setHeight(root.scrollHeight);
      setLines(next);
    };
    const onOver = (e: PointerEvent) => {
      // Not mid-drag: the dragged row moves under the cursor, and lines
      // chasing it would be noise on top of the drop feedback.
      if (e.buttons !== 0) return show(null);
      const row = (e.target as Element | null)?.closest?.("[data-sidebar-task-row]");
      show(row?.getAttribute("data-sidebar-task-row") ?? null);
    };
    const onLeave = () => show(null);
    root.addEventListener("pointerover", onOver);
    root.addEventListener("pointerleave", onLeave);
    return () => {
      root.removeEventListener("pointerover", onOver);
      root.removeEventListener("pointerleave", onLeave);
    };
  }, [containerRef]);

  if (lines.length === 0) return null;
  return (
    <svg
      data-testid="spawn-links"
      aria-hidden
      className="pointer-events-none absolute left-0 top-0 z-10 w-full overflow-visible"
      style={{ height }}
    >
      {lines.map(l => (
        <g key={l.key} data-spawn-link={l.key}>
          {/* Faint and thin: a hint about a relationship, drawn over rows
              the user is reading, not a highlight. The accent was too loud. */}
          <path d={l.d} fill="none" stroke="var(--color-fg-faint)" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" opacity={0.7} />
          <circle cx={l.x} cy={l.y} r={1.5} fill="var(--color-fg-faint)" opacity={0.7} />
        </g>
      ))}
    </svg>
  );
}
