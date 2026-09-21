# Future work: a kanban board over tasks

Deferred, not yet built. Captured after surveying how Multica
(<https://github.com/multica-ai/multica>) actually builds its board, and
what termic already has to hang one on. Related:
[agent-orchestration.md](agent-orchestration.md) problem 6 (termic has no
planning layer) is the same gap seen from the agent's side;
[dock-widget.md](dock-widget.md) is the same "see every agent's state at a
glance" need in ambient form.

## The problem

Past a handful of parallel tasks, the sidebar answers "where is task X"
but not "what stage is everything at". The working / settled / attention
badges exist, but you scan them row by row across projects. A board is the
at-a-glance answer, and Multica's marketing shot (six agents and humans
moving cards) is the reference for what that looks like.

## Prior art: how Multica's board is actually built

Researched from the repo itself (shallow clone, `packages/views/issues/`):

- **The board is entirely self-written.** No kanban library exists in the
  dependency tree: `board-view.tsx` (~886 lines), `board-column.tsx`,
  `board-card.tsx`, `hidden-columns-panel.tsx` are hand-rolled on their
  own component stack. "Use a kanban component" is not an option anyone
  is taking, including them. (That stack, for reference: shadcn-style
  generated primitives on the Base UI headless engine - the `base-nova`
  style, pulled from the paid reui.io registry - plus lucide icons, sonner
  toasts, cmdk, and `react-virtuoso`, which is what virtualizes each
  column's card list.)
- The one board-specific external dependency is **dnd-kit**
  (`@dnd-kit/core`, `-modifiers`, `-sortable`, `-utilities`) for the drag
  primitives: `DndContext`, `DragOverlay`, `PointerSensor` with a 5px
  activation distance, `arrayMove`.
- Three hand-written helpers wrap dnd-kit:
  - `drag-utils.ts`: a custom `CollisionDetection`
    (`makeKanbanCollision`: `pointerWithin` against cards first, falling
    back to `closestCenter`), plus the column group-key vocabulary
    (`status:`, `assignee:`, `project:`, `property:`) and move math.
  - `use-drag-settle.ts`: a drag/settle state machine. Local column state
    mirrors the TanStack Query cache between drags; during a drag the
    local state wins; mutations fire on settle. A `columnsEqual` check
    skips no-op writes - the same discipline as termic's bear trap 8,
    arrived at independently.
  - `use-board-drag-pan.ts`: dragging blank board area pans the board,
    activation distance aligned with the PointerSensor's, with a long
    interactive-element exclusion list so card presses never pan.
- Columns paginate (infinite-scroll sentinel plus a load-more footer per
  column). Grouping is by status / assignee / project / custom property.
- The status model behind it is **explicit and stored**: 7 built-in
  statuses in 4 lifecycle categories (backlog, todo | in_progress,
  in_review, blocked | done | cancelled). Agents move their own issues via
  the Multica CLI (in_progress when picked up, in_review on delivery); the
  server intervenes only on run-failure rollback (in_progress -> todo) and
  PR merge (-> done). `done` is a human click. That machinery works
  because Multica is a server product whose agents write status back
  through its CLI - and it is the part termic should NOT copy.

## Constraints (decided up front)

1. **Derived columns, not a stored state machine.** Multica's board is the
   system of record because the agent itself writes status back. Termic
   has no backend and the terminal is the ground truth; a hand-moved card
   would drift from the PTY ("card says done, agent still working") with
   no reconciliation path. Columns must be projections of real state.
2. **The board is a view, not a surface agents live in.** Like Dashboard:
   a `setView` overlay, mounted only while looked at, zero effect on PTY
   lifecycle. No new window label, no capability changes.
3. **Be the third consumer of the extracted work-state factoring.**
   `src/lib/taskWorkState.ts` was factored out precisely so Sidebar and
   Dashboard cannot drift; the board is its third consumer, not a new
   classifier.
4. **Only drags that mean something.** Multica can move a card anywhere
   because any (issue, status) pair is valid. Termic has roughly two
   meaningful drag targets: to Archived (fires the real archive path,
   confirm first) and reorder within a column (`task_reorder` already
   exists). Everything else is read-only.

## The design sketch

Columns, all derived from state that already exists:

| Column | Source |
| --- | --- |
| Needs attention | `taskWorkState` = attention (agent blocked on you) |
| Working | = working (agent mid-turn) |
| Settled | = done badge (turn ended, awaiting you) |
| In review | `pr_url` set, forge watch open (`forge.rs`) |
| Archived | `archived=true` (the History data; drop-to-archive target) |

Open shape questions: per-project board vs one all-projects board with
project accents (Multica groups by project too); whether a "created but
never worked" backlog column exists at all (termic tasks start working at
creation, so today there is no not-started state to show); card contents
(name, agent glyph, work badge, PR badge, age).

Rendering follows the counts-and-invariants discipline: a board card that
subscribed to per-keystroke fields would re-render on every title tick, so
cards read the coarse work-state slice only. Mounted only while the view
is active, so idle cost is zero by construction.

## What NOT to do

- Do not add a `status` field to the Task record. The `order` precedent is
  UI position, which is different: it has no competing truth.
- Do not pull dnd-kit in without measuring. The sidebar already hand-rolls
  pointer-event drag for `task_reorder`; a board is a bigger surface, but
  bundle size and WKWebView pointer latency need a number before a new
  dependency lands.
- Do not render live terminal content on cards. No xterm, no per-tick
  text.
- Do not write through the store on every dragOver. Settle, then write
  once; skip no-ops (multica's `columnsEqual`, bear trap 8).
- Do not hide mounted task panes while the board is up. MainArea's
  `display: none` contract stands; the board is an overlay above it.

## Open questions

- Per-project board, or one global board grouped by project?
- Is drop-to-archive safe enough with a confirm dialog, or does archive
  stay a context-menu action and the column stays read-only?
- Third nav view beside Dashboard/History, or a mode inside the project
  header?
- Swimlanes by agent (Multica's assignee grouping): worth anything for one
  user and N agents?
