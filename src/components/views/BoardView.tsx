// Board view (docs/ui.md "Board view", issue #318): a global kanban over
// every task, swimlanes by agent, columns DERIVED from live state (see
// src/lib/taskBoardState.ts for the precedence). The terminal is the ground
// truth, so nothing here is a stored status and nothing a card shows can
// drift from the PTY.
//
// Rendering discipline (bear traps 5 and 8): the column assignment comes from
// ONE string-keyed selector (`selectBoardColumnKey`), so the view re-renders
// when a card changes column and only then; each card then subscribes to its
// own coarse tab slice (`selectTaskTabs`), the way Dashboard cards do. The
// view unmounts with the overlay, so idle cost is zero by construction.
//
// Drag discipline: hand-rolled pointer events, the same pattern as the
// sidebar's task reorder. Only two drags mean anything: reorder within a
// same-project group (settle -> `task_reorder`, whose Rust contract is
// same-project ids) and drop-to-archive (-> the shared `confirmAndArchive`,
// inheriting its confirm dialog and spinner). Everything else snaps back
// without a write.

import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Archive } from "lucide-react";
import { EMPTY_TABS, selectTaskTabs, useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { usePr } from "@/store/pr";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { TaskLocationIcon } from "@/components/TaskLocationIcon";
import { TaskWorkBadge } from "@/components/TaskWorkBadge";
import { TaskPrBadge } from "@/components/TaskPrBadge";
import { taskLabel } from "@/lib/taskLabel";
import { taskWorkBadge, type WorkStatePrefs } from "@/lib/taskWorkState";
import {
  BOARD_STATE_COLUMNS,
  boardCellGroups,
  boardLanes,
  taskBoardColumn,
  type BoardColumn,
  type BoardStateColumn,
} from "@/lib/taskBoardState";
import { selectBoardColumnKey } from "@/lib/boardColumnKey";
import { agentDisplayName } from "@/lib/agents";
import { groupOf } from "@/lib/projectGroups";
import { accentCss } from "@/lib/accents";
import { confirmAndArchive } from "@/lib/archiveTask";
import { taskReorder } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { Agent, Project, Task } from "@/lib/types";
import type { TFunction } from "i18next";

/** Everything a card needs that is the SAME for every card, hoisted so N
 *  cards do not hold N subscriptions to the same slices (Dashboard's
 *  TaskRowContext pattern). */
interface CardContext {
  agents: Agent[];
  useBranchAsTaskName: boolean;
  workPrefs: WorkStatePrefs;
}

type DragTarget = { kind: "archive" } | { kind: "reorder" } | null;

const COL_LABEL: Record<BoardStateColumn, string> = {
  attention: "board.colAttention",
  working: "board.colWorking",
  review: "board.colReview",
  settled: "board.colSettled",
};

/** The dot / card-edge colour each column wears, all @theme tokens: warn is
 *  the attention bell's colour, accent marks the actively-working agent,
 *  pr-open is the green PR glyph, info is the settled bullet. A card's left
 *  edge repeats its column's colour so the swimlane grid scans without
 *  reading the headers. */
const COL_ACCENT: Record<BoardStateColumn, string> = {
  attention: "var(--color-warn)",
  working: "var(--color-accent)",
  review: "var(--color-pr-open)",
  settled: "var(--color-info)",
};

interface DragSnapshot {
  taskId: string;
  x: number;
  y: number;
  grabDX: number;
  grabDY: number;
  width: number;
  target: DragTarget;
}

function ageLabel(created: string, t: TFunction): string {
  const mins = Math.max(1, Math.floor((Date.now() - new Date(created).getTime()) / 60000));
  if (mins < 60) return t("board.ageMinutes", { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("board.ageHours", { count: hours });
  return t("board.ageDays", { count: Math.floor(hours / 24) });
}

export function BoardView() {
  const { t } = useTranslation("chrome");
  const tasks       = useApp(s => s.tasks);
  const projects    = useApp(s => s.projects);
  const agents      = useApp(s => s.agents);
  const groupColors = useApp(s => s.groupColors);
  const setView     = useApp(s => s.setView);
  const settledHighlight  = usePrefs(s => s.settledHighlight);
  const workingIndicator  = usePrefs(s => s.workingIndicator);
  const useBranchAsTaskName = usePrefs(s => s.useBranchAsTaskName);
  const workPrefs: WorkStatePrefs = { settledHighlight, workingIndicator };

  // Re-render trigger for PR polls, nothing more. The pr store lives outside
  // useApp precisely so its 60s tick re-renders nobody by default; the board
  // opts back in because an open -> merged transition moves a card. The value
  // itself is unused: selectBoardColumnKey reads the snapshot, and
  // useSyncExternalStore re-reads it during the render this triggers.
  usePr(s => Object.values(s.byTask).map(e => e.lookup?.pr?.state ?? "?").join("|"));

  const columnKey = useApp(selectBoardColumnKey(workPrefs));
  const columnOf = useMemo(() => {
    const pr = usePr.getState().byTask;
    const tabs = useApp.getState().tabs;
    const map = new Map<string, BoardColumn>();
    for (const w of tasks) {
      map.set(w.id, taskBoardColumn(w, tabs[w.id] ?? EMPTY_TABS, pr[w.id]?.lookup ?? null, workPrefs));
    }
    return map;
    // columnKey folds in every tab/PR/archive change that can move a card;
    // `tasks` identity covers adds, removes and reorders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, columnKey, settledHighlight, workingIndicator]);

  const lanes = useMemo(() => boardLanes(tasks, agents), [tasks, agents]);
  const projectOrder = useMemo(() => projects.map(p => p.id), [projects]);
  const projectById = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects]);
  const projectAccent = (p: Project | undefined): string | undefined => {
    const g = p ? groupOf(p) : null;
    return g ? accentCss(groupColors[g]) : undefined;
  };

  const liveTasks = useMemo(() => tasks.filter(w => !w.archived), [tasks]);
  const archivedTasks = useMemo(() => tasks.filter(w => w.archived), [tasks]);
  const colCounts = useMemo(() => {
    const counts: Record<BoardStateColumn, number> = { attention: 0, working: 0, review: 0, settled: 0 };
    for (const w of liveTasks) {
      const c = columnOf.get(w.id);
      if (c && c !== "archived") counts[c]++;
    }
    return counts;
  }, [liveTasks, columnOf]);

  // ── Drag: reorder within a same-project group, or drop-to-archive ─────
  //
  // The document-level listener pattern from the sidebar's task drag: the
  // listeners cannot live on the card because the pointer leaves it mid-drag.
  const [drag, setDrag] = useState<DragSnapshot | null>(null);
  const [preview, setPreview] = useState<{ projectId: string; ids: string[] } | null>(null);
  const previewRef = useRef<typeof preview>(null);
  const armedRef = useRef<{
    id: string; projectId: string; lane: string; column: BoardStateColumn;
    groupIds: string[]; x: number; y: number; started: boolean;
    grabDX: number; grabDY: number; width: number; target: DragTarget;
  } | null>(null);
  // A completed drop still fires a click on the card, which would activate
  // the task the user only meant to move. Same suppression pattern as the
  // sidebar's taskClickSuppressed.
  const clickSuppressed = useRef(false);

  const setPreviewBoth = (v: typeof preview) => { previewRef.current = v; setPreview(v); };

  const onCardPointerDown = (e: React.PointerEvent, w: Task, lane: string, column: BoardStateColumn) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Real controls (the PR badge is a button) and portaled menus/dialogs
    // never start a drag. Same bail-out set as the sidebar.
    if (target.closest('button, input, a, [data-no-drag], [role="menu"], [role="dialog"]')) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // The group the card starts in, in RENDERED order (preview-aware would be
    // wrong: a drag always starts from the settled order).
    const groupIds = liveTasks
      .filter(u => u.project_id === w.project_id && u.cli === lane && columnOf.get(u.id) === column)
      .map(u => u.id);
    armedRef.current = {
      id: w.id, projectId: w.project_id, lane, column, groupIds,
      x: e.clientX, y: e.clientY, started: false,
      grabDX: e.clientX - rect.left, grabDY: e.clientY - rect.top, width: rect.width,
      target: null,
    };
    document.addEventListener("pointermove", onDragPointerMove);
    document.addEventListener("pointerup", onDragPointerUp);
    document.addEventListener("pointercancel", onDragPointerUp);
  };

  const onDragPointerMove = (e: PointerEvent) => {
    const armed = armedRef.current;
    if (!armed) return;
    if (!armed.started) {
      const dx = e.clientX - armed.x;
      const dy = e.clientY - armed.y;
      if (dx * dx + dy * dy < 16) return; // 4px threshold, same as the sidebar
      armed.started = true;
    }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    let target: DragTarget = null;
    if (el?.closest("[data-board-archive]")) {
      target = { kind: "archive" };
    } else {
      const cell = el?.closest<HTMLElement>("[data-board-cell]");
      const group = el?.closest<HTMLElement>("[data-board-project-group]");
      // Reorder only inside the ORIGIN group: `order` competes within one
      // project (task_reorder's contract), so a card dragged over another
      // project, lane or column has no meaningful drop and snaps back.
      if (cell && group
          && cell.dataset.lane === armed.lane
          && cell.dataset.column === armed.column
          && group.dataset.boardProjectGroup === armed.projectId) {
        target = { kind: "reorder" };
        // First card whose midpoint is below the cursor wins; none = drop at
        // the end of the group. Midpoint rule identical to the sidebar's.
        let beforeId: string | null = null;
        for (const c of Array.from(group.querySelectorAll<HTMLElement>("[data-board-task-id]"))) {
          if (c.dataset.boardTaskId === armed.id) continue;
          const r = c.getBoundingClientRect();
          if (e.clientY < (r.top + r.bottom) / 2) { beforeId = c.dataset.boardTaskId!; break; }
        }
        const base = previewRef.current?.projectId === armed.projectId ? previewRef.current.ids : armed.groupIds;
        const rest = base.filter(id => id !== armed.id);
        const insertAt = beforeId ? rest.indexOf(beforeId) : rest.length;
        const next = [...rest];
        next.splice(insertAt === -1 ? rest.length : insertAt, 0, armed.id);
        // No-op guard (bear trap 8): identical order writes nothing.
        if (next.some((id, i) => id !== base[i])) setPreviewBoth({ projectId: armed.projectId, ids: next });
      }
    }
    armed.target = target;
    setDrag({
      taskId: armed.id, x: e.clientX, y: e.clientY,
      grabDX: armed.grabDX, grabDY: armed.grabDY, width: armed.width, target,
    });
  };

  const onDragPointerUp = () => {
    document.removeEventListener("pointermove", onDragPointerMove);
    document.removeEventListener("pointerup", onDragPointerUp);
    document.removeEventListener("pointercancel", onDragPointerUp);
    const armed = armedRef.current;
    armedRef.current = null;
    const pv = previewRef.current;
    setDrag(null);
    setPreviewBoth(null);
    if (!armed?.started) return;
    // Swallow the click that follows this pointerup (see the ref's comment).
    clickSuppressed.current = true;
    setTimeout(() => { clickSuppressed.current = false; }, 0);

    if (armed.target?.kind === "archive") {
      const w = useApp.getState().tasks.find(u => u.id === armed.id);
      // confirmAndArchive owns the dialog, the delete-branch checkbox, the
      // open-PR warning and the spinner; the board just hands the task over.
      if (w) void confirmAndArchive(w);
      return;
    }
    if (!pv || pv.projectId !== armed.projectId) return;

    // Merge the reordered group back into the project's full id list:
    // non-group tasks of the project (other columns, other lanes) keep their
    // relative positions, the group lands where its first member was.
    const all = useApp.getState().tasks;
    const projIds = all.filter(u => u.project_id === armed.projectId && !u.archived).map(u => u.id);
    const groupSet = new Set(armed.groupIds);
    const merged: string[] = [];
    let inserted = false;
    for (const id of projIds) {
      if (groupSet.has(id)) {
        if (!inserted) { merged.push(...pv.ids); inserted = true; }
        continue;
      }
      merged.push(id);
    }
    if (!inserted) merged.push(...pv.ids);
    if (merged.every((id, i) => id === projIds[i])) return; // no-op, write nothing
    // Write the store once so board and sidebar agree immediately, then
    // persist through the same IPC the sidebar drag uses. Fall back to a
    // refetch if the write fails, same as the sidebar.
    const byId = new Map(all.map(u => [u.id, u]));
    const queue = [...merged];
    const next = all.map(u =>
      u.project_id === armed.projectId && !u.archived ? byId.get(queue.shift()!)! : u);
    useApp.setState({ tasks: next });
    taskReorder(merged).catch(() => { void useApp.getState().loadAll(); });
  };

  const onCardClick = (w: Task) => {
    if (clickSuppressed.current) return;
    useApp.getState().setActiveTask(w.id);
  };

  const dragTask = drag ? tasks.find(w => w.id === drag.taskId) : undefined;

  return (
    <div className="flex h-full flex-col" data-testid="board-view">
      {/* Column headers, aligned with the per-lane grids below. */}
      <div className="flex shrink-0 border-b border-[var(--color-border-soft)]">
        <div className="grid min-w-0 flex-1" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
          {BOARD_STATE_COLUMNS.map(col => (
            <div key={col} className="flex items-center gap-1.5 px-3 py-2 text-[12px] font-semibold text-[var(--color-fg-dim)]">
              <span className="h-[6px] w-[6px] shrink-0 rounded-full" style={{ backgroundColor: COL_ACCENT[col] }} />
              {t(COL_LABEL[col])}
              <span
                className="ml-0.5 rounded-full px-1.5 tabular-nums text-[10.5px] font-medium text-[var(--color-fg-faint)]"
                style={colCounts[col] > 0 ? { backgroundColor: "var(--color-hover)" } : undefined}
              >
                {colCounts[col]}
              </span>
            </div>
          ))}
        </div>
        <div className="w-[240px] shrink-0 border-l border-[var(--color-border-soft)] px-3 py-2 text-[12px] font-semibold text-[var(--color-fg-dim)]">
          {t("board.colArchived")}
          <span className="ml-1.5 tabular-nums text-[11px] text-[var(--color-fg-faint)]">{archivedTasks.length}</span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Swimlanes */}
        <div className="min-w-0 flex-1 overflow-auto">
          {lanes.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <div className="text-[14px] font-semibold">{t("board.emptyTitle")}</div>
              <div className="text-[12.5px] text-[var(--color-fg-dim)]">{t("board.emptyBody")}</div>
            </div>
          ) : lanes.map(lane => (
            <section key={lane} data-board-lane={lane}>
              <header className="flex items-center gap-2 border-b border-[var(--color-border-soft)] px-3 py-1.5">
                <span className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(lane, agents)] || "text-[var(--color-fg-faint)]")}>
                  <CliIcon cli={resolveIconId(lane, agents)} className="h-3.5 w-3.5" />
                </span>
                <span className="text-[12px] font-semibold">{agentDisplayName(lane, agents)}</span>
              </header>
              <div className="grid" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
                {BOARD_STATE_COLUMNS.map(col => (
                  <BoardCell
                    key={col}
                    lane={lane}
                    column={col}
                    tasks={liveTasks.filter(w => w.cli === lane && columnOf.get(w.id) === col)}
                    projectOrder={projectOrder}
                    projectById={projectById}
                    projectAccent={projectAccent}
                    ctx={{ agents, useBranchAsTaskName, workPrefs }}
                    preview={preview}
                    dragSourceId={drag?.taskId ?? null}
                    onCardPointerDown={onCardPointerDown}
                    onCardClick={onCardClick}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>

        {/* Archived: one full-height column, agent-agnostic, read-only apart
            from being the drop-to-archive target. */}
        <aside
          data-board-archive
          className={cn(
            "flex w-[240px] shrink-0 flex-col overflow-auto border-l border-[var(--color-border-soft)] bg-[var(--color-bg-1)] p-2",
            drag?.target?.kind === "archive" && "bg-[var(--color-hover)] ring-1 ring-inset ring-[var(--color-accent-soft)]",
          )}
        >
          {drag && (
            <div className="mb-2 rounded-md border border-dashed border-[var(--color-border)] px-2 py-1.5 text-center text-[11.5px] text-[var(--color-fg-faint)]">
              {t("board.archiveHint")}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            {archivedTasks.map(w => (
              <ArchivedCard key={w.id} task={w} project={projectById.get(w.project_id)} ctx={{ agents, useBranchAsTaskName, workPrefs }} />
            ))}
          </div>
          {archivedTasks.length > 0 && (
            <button
              onClick={() => setView("history")}
              className="mt-3 shrink-0 rounded-md px-2 py-1.5 text-center text-[12px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
            >
              {t("board.openHistory")}
            </button>
          )}
        </aside>
      </div>

      {/* Drag ghost: follows the pointer while the source card dims in place.
          The tilt + shadow say "lifted", the way every kanban shows it.
          pointer-events-none so elementFromPoint sees the cells beneath it;
          transform + shadow are compositor-only, so the ghost costs nothing
          to move. */}
      {drag && dragTask && (
        <div
          className="pointer-events-none fixed z-50 rounded-md border border-[var(--color-accent-soft)] bg-[var(--color-bg-1)] px-2.5 py-2 shadow-lg"
          style={{
            left: drag.x - drag.grabDX,
            top: drag.y - drag.grabDY,
            width: drag.width,
            transform: "rotate(2deg) scale(1.02)",
          }}
        >
          <div className="flex items-center gap-2">
            <span className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(dragTask.cli, agents)] || "text-[var(--color-fg-faint)]")}>
              <CliIcon cli={resolveIconId(dragTask.cli, agents)} className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
              {taskLabel(dragTask, useBranchAsTaskName)}
            </span>
            {drag.target?.kind === "archive" && (
              <Archive className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-dim)]" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Cell ────────────────────────────────────────────────────────────────

function BoardCell({ lane, column, tasks, projectOrder, projectById, projectAccent, ctx, preview, dragSourceId, onCardPointerDown, onCardClick }: {
  lane: string;
  column: BoardStateColumn;
  tasks: Task[];
  projectOrder: string[];
  projectById: Map<string, Project>;
  projectAccent: (p: Project | undefined) => string | undefined;
  ctx: CardContext;
  preview: { projectId: string; ids: string[] } | null;
  dragSourceId: string | null;
  onCardPointerDown: (e: React.PointerEvent, w: Task, lane: string, column: BoardStateColumn) => void;
  onCardClick: (w: Task) => void;
}) {
  const groups = boardCellGroups(tasks, projectOrder);
  return (
    <div
      data-board-cell
      data-lane={lane}
      data-column={column}
      className="flex min-h-[72px] flex-col gap-2 border-b border-r border-[var(--color-border-soft)] p-1.5"
    >
      {groups.map(g => {
        const project = projectById.get(g.projectId);
        const ordered = preview?.projectId === g.projectId
          ? preview.ids.map(id => g.tasks.find(w => w.id === id)).filter((w): w is Task => !!w)
          : g.tasks;
        return (
          <div key={g.projectId} data-board-project-group={g.projectId}>
            <div className="flex items-center gap-1.5 px-1 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[var(--color-fg-faint)]">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: projectAccent(project) ?? "var(--color-fg-faint)" }}
              />
              <span className="truncate">{project?.name ?? g.projectId}</span>
            </div>
            {/* While the pointer holds cards over this group, the accent ring
                is the "this is where the drop lands" signal; everywhere else
                is not a target and stays quiet. */}
            <div
              className={cn(
                "flex flex-col gap-1 rounded-md",
                dragSourceId != null && preview?.projectId === g.projectId
                  && "ring-1 ring-inset ring-[var(--color-accent-soft)]",
              )}
            >
              {ordered.map(w => (
                <BoardCard
                  key={w.id}
                  task={w}
                  ctx={ctx}
                  column={column}
                  isDragSource={dragSourceId === w.id}
                  onPointerDown={e => onCardPointerDown(e, w, lane, column)}
                  onClick={() => onCardClick(w)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Cards ───────────────────────────────────────────────────────────────
// Each card subscribes to ONLY its own tab slice (selectTaskTabs), so a
// keystroke in one task re-renders one card, not the board.

function BoardCard({ task: w, ctx, column, isDragSource, onPointerDown, onClick }: {
  task: Task;
  ctx: CardContext;
  column: BoardStateColumn;
  isDragSource: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onClick: () => void;
}) {
  const { t } = useTranslation("chrome");
  const tabs = useApp(selectTaskTabs(w.id));
  // Same helper, same precedence as the sidebar and the dashboard, so one
  // task can never wear two different badges on two surfaces.
  const badge = taskWorkBadge(tabs, ctx.workPrefs);
  const label = taskLabel(w, ctx.useBranchAsTaskName);
  // The card's left edge repeats its column's accent (softened, so a grid of
  // them reads as tint, not stripes). color-mix with a theme token: if a
  // theme drops the variable the invalid value is discarded and the default
  // border applies, same discipline as the dashboard's guide line.
  const edge = `color-mix(in srgb, ${COL_ACCENT[column]} 55%, transparent)`;

  return (
    <div
      data-board-task-id={w.id}
      role="button"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onKeyDown={ev => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onClick(); }
      }}
      style={{ borderLeftColor: edge }}
      className={cn(
        "flex cursor-pointer flex-col gap-0.5 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] px-2.5 py-1.5 text-left hover:border-[var(--color-accent-soft)] hover:shadow-sm",
        isDragSource && "border-dashed opacity-40",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(w.cli, ctx.agents)] || "text-[var(--color-fg-faint)]")}>
          <CliIcon cli={resolveIconId(w.cli, ctx.agents)} className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{label}</span>
        <span className="shrink-0 tabular-nums text-[10.5px] text-[var(--color-fg-faint)]">{ageLabel(w.created, t)}</span>
      </div>
      <div className="flex items-center gap-1.5 pl-[22px]">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-fg-faint)]">{w.branch}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          <TaskLocationIcon isMainCheckout={w.is_main_checkout} />
          <TaskPrBadge task={w} />
          {badge && <TaskWorkBadge reason={badge} />}
        </span>
      </div>
    </div>
  );
}

/** The archived column's card: read-only. Restore stays in History, so the
 *  card has no click action and the column footer links there instead. */
function ArchivedCard({ task: w, project, ctx }: {
  task: Task;
  project: Project | undefined;
  ctx: CardContext;
}) {
  return (
    <div
      data-board-task-id={w.id}
      className="flex items-center gap-2 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] px-2.5 py-1.5 opacity-70"
    >
      <span className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(w.cli, ctx.agents)] || "text-[var(--color-fg-faint)]")}>
        <CliIcon cli={resolveIconId(w.cli, ctx.agents)} className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px]">{taskLabel(w, ctx.useBranchAsTaskName)}</span>
      {project && <span className="shrink-0 truncate text-[10.5px] text-[var(--color-fg-faint)]">{project.name}</span>}
    </div>
  );
}
