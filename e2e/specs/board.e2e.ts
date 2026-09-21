// Board view (docs/ui.md "Board view", issue #318): nav entry, derived
// columns, the two drags that mean something (same-project reorder,
// drop-to-archive with its confirm dialog), and the drag that does not
// (cross-column snap-back).
//
// Deterministic by construction: every task here is idle, so it sits in
// Settled regardless of the work-badge prefs. The transient working/attention
// columns are covered by the unit matrix in src/lib/taskBoardState.test.ts;
// racing the fake agent's sub-second busy window here would be the flaky
// version of the same assertion.

import {
  archiveTask,
  clickByText,
  dismissOverlays,
  ensureActiveTask,
  openTask,
  pointerDrag,
  requireTermicApi,
  snap,
  waitForAppShell,
  waitGone,
  waitVisible,
} from "../helpers.js";

const COLUMN = (column: string) => `[data-board-cell][data-column="${column}"]`;
const LANE_IN = (lane: string, column: string) => `${COLUMN(column)} [data-board-lane="${lane}"]`;
const CARD = (id: string) => `[data-board-task-id="${id}"]`;

/** Ids of a project's live tasks in store order (what the sidebar shows). */
const projectTaskOrder = () =>
  browser.execute(() =>
    window.__termic!.useApp
      .getState()
      .tasks.filter((w: any) => !w.archived)
      .map((w: any) => w.id),
  );

/** Card ids rendered in one board lane, in DOM order. */
const cellCardOrder = (lane: string, column: string) =>
  browser.execute(
    sel =>
      [...document.querySelectorAll<HTMLElement>(`${sel} [data-board-task-id]`)]
        .map(el => el.dataset.boardTaskId),
    LANE_IN(lane, column),
  );

describe("board view", () => {
  let t1 = "";
  let t2 = "";
  let t3 = "";
  let t4 = "";

  after(async () => {
    // t1 is archived by its own case; archive what survived. Deleting by id
    // is enough here: each openTask either returned or threw before creating.
    for (const id of [t2, t3, t4]) {
      if (!id) continue;
      const archived = await browser.execute(
        i => !!window.__termic!.useApp.getState().tasks.find((w: any) => w.id === i)?.archived,
        id,
      );
      if (!archived) await archiveTask(id);
    }
  });

  it("opens from the sidebar nav and places untouched tasks in Not started, one lane per agent", async () => {
    await waitForAppShell();
    await requireTermicApi();
    t1 = await openTask("board-a", true, "fakeagent");
    t2 = await openTask("board-b", false, "fakeagent");
    t3 = await openTask("board-c", false, "fakecapture");

    await clickByText("Board");
    await waitVisible('[data-testid="board-view"]');

    // One lane per cli actually in use, named for the agent.
    await waitVisible('[data-board-lane="fakeagent"]');
    await waitVisible('[data-board-lane="fakecapture"]');

    // Tasks nobody has submitted anything to are Not started, under their
    // agent's lane divider. This is the distinction that keeps "the agent
    // is sitting idle" from reading as "the agent finished".
    await waitVisible(`${LANE_IN("fakeagent", "backlog")} ${CARD(t1)}`);
    await waitVisible(`${LANE_IN("fakeagent", "backlog")} ${CARD(t2)}`);
    await waitVisible(`${LANE_IN("fakecapture", "backlog")} ${CARD(t3)}`);

    // The column accent edge is a color-mix over a theme token. Assert the
    // computed value: if the engine dropped the color-mix, the card would
    // render with the default border on all four edges and the accent would
    // be an invisible no-op that a screenshot cannot catch.
    const edge = await browser.execute(sel => {
      const cs = getComputedStyle(document.querySelector(sel) as HTMLElement);
      return { left: cs.borderLeftColor, right: cs.borderRightColor };
    }, `${LANE_IN("fakeagent", "backlog")} ${CARD(t1)}`);
    expect(edge.left).not.toBe(edge.right);

    await snap("board.png");
  });

  it("clicking a card activates the task and leaves the board", async () => {
    await browser.execute(
      sel => (document.querySelector(sel) as HTMLElement).click(),
      `${LANE_IN("fakeagent", "backlog")} ${CARD(t2)}`,
    );
    await browser.waitUntil(
      () =>
        browser.execute(
          id => window.__termic!.useApp.getState().activeTaskId === id,
          t2,
        ),
      { timeout: 5_000, timeoutMsg: "card click never activated the task" },
    );
    await waitGone('[data-testid="board-view"]');
  });

  it("dragging within a same-project group reorders, and the order persists", async () => {
    t4 = await openTask("board-d", false, "fakeagent");
    await clickByText("Board");
    await waitVisible('[data-testid="board-view"]');
    await dismissOverlays();

    // All three fakeagent tasks are untouched, so the backlog group holds
    // them in store order: t1, t2, then the just-created t4.
    const before = await cellCardOrder("fakeagent", "backlog");
    expect(before).toEqual([t1, t2, t4]);

    // Land on the TOP half of t1's card: the midpoint rule inserts before it.
    await pointerDrag(
      `${LANE_IN("fakeagent", "backlog")} ${CARD(t4)}`,
      `${LANE_IN("fakeagent", "backlog")} ${CARD(t1)}`,
      { land: "top" },
    );

    await browser.waitUntil(
      async () => JSON.stringify(await cellCardOrder("fakeagent", "backlog")) === JSON.stringify([t4, t1, t2]),
      { timeout: 5_000, timeoutMsg: "board cell never showed the reordered cards" },
    );
    // The store is the same truth the sidebar renders, and task_reorder
    // persists it. t3 (fakecapture lane, same project) keeps its place.
    const storeOrder = (await projectTaskOrder()) as string[];
    expect(storeOrder.indexOf(t4)).toBeLessThan(storeOrder.indexOf(t1));
    expect(storeOrder.indexOf(t1)).toBeLessThan(storeOrder.indexOf(t2));
  });

  it("dragging to another column snaps back with no dialog and no write", async () => {
    await pointerDrag(
      `${LANE_IN("fakeagent", "backlog")} ${CARD(t2)}`,
      COLUMN("working"),
    );
    // No drop target outside the origin group and the Archived column, so the
    // card stays put and nothing (confirm dialog included) appears.
    const dialogUp = await browser.execute(
      () => !!document.querySelector('[role="dialog"]'),
    );
    expect(dialogUp).toBe(false);
    await waitVisible(`${LANE_IN("fakeagent", "backlog")} ${CARD(t2)}`);
    const archived = await browser.execute(
      id => !!window.__termic!.useApp.getState().tasks.find((w: any) => w.id === id)?.archived,
      t2,
    );
    expect(archived).toBe(false);
  });

  it("a task that finished a turn moves out of Not started into Settled", async () => {
    // Submit through the real input path (waitForAgentReady first, per the
    // suite rule) and let the fake agent run its busy -> idle cycle: the
    // classifier must see working then done, and the card must end in
    // Settled. This is the regression case for "a task that did nothing
    // shows as completed": doing something is what moves the card.
    const { submitToAgent, waitForAgentReady, waitForWorkBadge, waitForWorkBadgeGone } = await import("../helpers.js");
    await ensureActiveTask(t1);
    await waitForAgentReady(t1);
    await submitToAgent(t1, "write something to the terminal");
    await waitForWorkBadge(t1, "working", { timeout: 20_000 });
    await waitForWorkBadgeGone(t1, "working", { timeout: 30_000 });

    await clickByText("Board");
    await waitVisible('[data-testid="board-view"]');
    await browser.waitUntil(
      async () => !!(await cellCardOrder("fakeagent", "settled")).includes(t1),
      { timeout: 30_000, timeoutMsg: "submitted task never landed in Settled" },
    );
    // Its untouched sibling stays behind in Not started.
    await waitVisible(`${LANE_IN("fakeagent", "backlog")} ${CARD(t2)}`);
    await snap("board-after-submit.png");
  });

  it("dropping a card on the Archived column archives it through the real confirm dialog", async () => {
    await dismissOverlays();
    // t1, now in Settled: this case deliberately drags from the column
    // ADJACENT to Archived. A source on the board's far side (backlog) and
    // the target cannot be on screen together in a narrow window, and the
    // drag helper's scroll-into-view of one endpoint moves the other — the
    // gesture then releases over whatever column is actually under the
    // cursor and the dialog never comes.
    await pointerDrag(
      `${LANE_IN("fakeagent", "settled")} ${CARD(t1)}`,
      "[data-board-archive]",
    );

    // The shared confirmAndArchive dialog, scoped by its title per the suite's
    // dialog rule. Repo-root task, so the confirm label is "Remove entry".
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll('[role="dialog"]')].some(d =>
            d.textContent?.includes('Archive "board-a"')),
        ),
      { timeout: 5_000, timeoutMsg: "archive confirm dialog never appeared" },
    );
    await clickByText("Remove entry");

    // The card moves to the Archived column and the store agrees; the
    // fakecapture lane stays, its task was never touched.
    await waitVisible(`[data-board-archive] ${CARD(t1)}`);
    await browser.waitUntil(
      () =>
        browser.execute(
          id => !!window.__termic!.useApp.getState().tasks.find((w: any) => w.id === id)?.archived,
          t1,
        ),
      { timeout: 10_000, timeoutMsg: "task never landed as archived in the store" },
    );
    await snap("board-after-archive.png");
  });
});
