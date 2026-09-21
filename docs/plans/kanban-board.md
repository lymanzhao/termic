# Plan: a kanban board view over tasks

Approved 2026-09-21, tracked in issue #318. Originated as
docs/ideas/kanban-board.md after surveying how Multica
(<https://github.com/multica-ai/multica>) builds its board; the research
below is kept because the "what NOT to copy" conclusions are load-bearing.

## What to build

A third nav view beside Dashboard and History: a **global board over every
task**, swimlanes by agent, with columns **derived from real state**. The
terminal is the ground truth; a hand-moved card would drift from the PTY
("card says done, agent still working") with no reconciliation path, so no
column is a stored status.

### View mechanics

- `View.page` gains `"board"` (`src/store/app.ts`, the union at the `View`
  interface). `setView("board")` already clears `activeTaskId`; no PTY
  lifecycle impact, no new window label, no capability changes.
- `MainArea.tsx`'s overlay chain gains a
  `view === "board" && !task ? <BoardView/> : null` branch in the same
  z-10 overlay container. The `display: none` contract for mounted task
  panes stands untouched; the board unmounts when the view is left, so
  idle cost is zero by construction.
- Sidebar primary nav gains a `NavItem` (lucide `Columns3`), label
  `t("navBoard")`, beside Dashboard and History. No keyboard shortcut in
  v1: Dashboard and History have none either.
- i18n: `navBoard` in the `sidebar` namespace and a `board: {...}` block
  in the `chrome` namespace, en + zh-CN (parity test enforces).

### Columns and swimlanes (derived, not stored)

New pure module `src/lib/taskBoardState.ts`, the **third consumer** of
`src/lib/taskWorkState.ts` (factored out precisely so Sidebar, Dashboard
and the board cannot drift). Per-task cell derivation, precedence top to
bottom:

```
archived                                  -> Archived (overrides all)
taskNeedsAttention                        -> Needs attention
taskWorking                               -> Working
PR open/draft, not main-checkout          -> In review
everything else (settled, idle, fresh)    -> Settled
```

- PR state: gate on the persisted `task.pr_url` / `task.pr_number`
  (zero-cost), read live state from `usePr(s => s.byTask[taskId])`. The
  gate matches `pollableTasks()` in `src/store/pr.ts` (main-checkout
  excluded), so the poller already keeps exactly these fresh. A
  merged/closed PR falls out of the column on the next poll.
- Swimlanes: one row per `task.cli` actually present among non-archived
  tasks, ordered claude / gemini / codex first, others alphabetical.
  Agents with no tasks render no row.
- The **Archived column spans full width** (archiving is agent-agnostic);
  the four state columns are cut into per-lane cells.
- Termic tasks start working at creation, so there is no not-started
  backlog column; a freshly spawned idle task lands in Settled.

### Cards

Task name, agent glyph, project color dot + project name, `TaskWorkBadge`,
PR badge (from the `usePr` entry), relative creation time. **No live
terminal content, no per-tick text.** Cards subscribe to the coarse
per-task slice only (`selectTaskTabs(taskId)`, `src/store/app.ts`),
exactly like Dashboard cards. Clicking a card calls `setActiveTask(id)`,
which flips the view back to the task, the same behavior as Dashboard
cards.

### Drag and drop: only drags that mean something

Hand-rolled pointer-event drag, the same pattern as the sidebar's
task reorder (`Sidebar.tsx`): pointerdown arms, 4px threshold,
document-level move/up listeners, local state during the drag, write once
on settle, no-op writes skipped (bear trap 8). **No dnd-kit** unless a
measured bundle-size / WKWebView pointer-latency number says the
hand-rolled version is insufficient.

Two drags are meaningful; everything else snaps back with no write:

1. **Reorder within a same-project cell.** Cards inside a cell are
   grouped by project (project dot + name as the group header); dragging
   reorders within the group only. Settle calls the existing
   `task_reorder` IPC, whose Rust contract is same-project ids
   (`src-tauri/src/lib.rs`, `order` only competes within one project).
   Cross-project order within a cell has no storage semantics and is not
   draggable.
2. **Drop into the Archived column.** Calls the existing
   `confirmAndArchive(task)` (`src/lib/archiveTask.ts`), inheriting the
   confirm dialog, delete-branch checkbox, open-PR warning,
   `dontAskAgain` pref and archiving spinner for free.

The Archived column is otherwise read-only in v1; restore stays in the
History view, with an "Open History" link at the column footer.

### Tests (land in the same commits)

- `src/lib/taskBoardState.test.ts`: the full precedence matrix, archived
  override, merged/closed PR falling out, main-checkout excluded from In
  review, swimlane ordering.
- `src/store/selectorFanout.test.ts`: invariant that the board view does
  not subscribe to the whole tabs map (coarse per-task slices only).
- New e2e spec `e2e/specs/board.spec.ts` (authoring rules in the `e2e`
  skill): nav opens the board, column derivation, drag-to-archive through
  the confirm flow, card click activates the task.
- i18n parity test covers the new keys automatically.

### Explicitly out of scope

- No `status` field on the Task record (the `order` precedent is UI
  position with no competing truth; a lifecycle status has one).
- No cross-project reorder.
- No per-agent swimlane reorder semantics beyond same-project cells.
- No keyboard shortcut (v1).

## Prior art: how Multica's board is actually built

Researched from the repo itself (shallow clone, `packages/views/issues/`),
kept as the reference for what a good board looks like and for the
discipline points termic shares:

- **The board is entirely self-written.** No kanban library exists in
  their dependency tree: `board-view.tsx` (~886 lines), `board-column.tsx`,
  `board-card.tsx` are hand-rolled on their own component stack.
- The one board-specific external dependency is **dnd-kit** for the drag
  primitives: `DndContext`, `DragOverlay`, `PointerSensor` with a 5px
  activation distance, `arrayMove`.
- Three hand-written helpers wrap dnd-kit: a custom `CollisionDetection`
  (`pointerWithin` against cards first, falling back to `closestCenter`);
  a drag/settle state machine where local column state mirrors the query
  cache between drags, local state wins during a drag, mutations fire on
  settle, and a `columnsEqual` check skips no-op writes (the same
  discipline as termic's bear trap 8, arrived at independently); and a
  drag-to-pan on blank board area.
- Their status model is **explicit and stored**: 7 built-in statuses,
  agents move their own issues via the Multica CLI. That works because
  Multica is a server product whose agents write status back, and it is
  the part termic deliberately does NOT copy: termic has no backend and
  the terminal is the ground truth.

## What NOT to do

- Do not add a `status` field to the Task record.
- Do not pull dnd-kit in without measuring.
- Do not render live terminal content on cards.
- Do not write through the store on every dragOver. Settle, then write
  once; skip no-ops.
- Do not hide mounted task panes while the board is up. MainArea's
  `display: none` contract stands; the board is an overlay above it.
