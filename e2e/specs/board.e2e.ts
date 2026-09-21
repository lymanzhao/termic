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
  openTask,
  pointerDrag,
  requireTermicApi,
  snap,
  waitForAppShell,
  waitGone,
  waitVisible,
} from "../helpers.js";

const CELL = (lane: string, column: string) =>
  `[data-board-lane="${lane}"] [data-board-cell][data-column="${column}"]`;
const CARD = (id: string) => `[data-board-task-id="${id}"]`;

/** Ids of a project's live tasks in store order (what the sidebar shows). */
const projectTaskOrder = () =>
  browser.execute(() =>
    window.__termic!.useApp
      .getState()
      .tasks.filter((w: any) => !w.archived)
      .map((w: any) => w.id),
  );

/** Card ids rendered in one board cell, in DOM order. */
const cellCardOrder = (lane: string, column: string) =>
  browser.execute(
    sel =>
      [...document.querySelectorAll<HTMLElement>(`${sel} [data-board-task-id]`)]
        .map(el => el.dataset.boardTaskId),
    CELL(lane, column),
  );

describe("board view", () => {
  let t1 = "";
  let t2 = "";
  let t3 = "";

  after(async () => {
    // t3 is archived by its own case; archive what survived. Deleting by id
    // is enough here: each openTask either returned or threw before creating.
    for (const id of [t1, t2]) {
      if (!id) continue;
      const archived = await browser.execute(
        i => !!window.__termic!.useApp.getState().tasks.find((w: any) => w.id === i)?.archived,
        id,
      );
      if (!archived) await archiveTask(id);
    }
  });

  it("opens from the sidebar nav and places idle tasks in Settled, one lane per agent", async () => {
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

    // Idle tasks with no PR are Settled, in a group under their project.
    await waitVisible(`${CELL("fakeagent", "settled")} ${CARD(t1)}`);
    await waitVisible(`${CELL("fakeagent", "settled")} ${CARD(t2)}`);
    await waitVisible(`${CELL("fakecapture", "settled")} ${CARD(t3)}`);
    await snap("board.png");
  });

  it("clicking a card activates the task and leaves the board", async () => {
    await browser.execute(
      sel => (document.querySelector(sel) as HTMLElement).click(),
      `${CELL("fakeagent", "settled")} ${CARD(t2)}`,
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
    await clickByText("Board");
    await waitVisible('[data-testid="board-view"]');
    await dismissOverlays();

    const before = await cellCardOrder("fakeagent", "settled");
    expect(before).toEqual([t1, t2]);

    // Land on the TOP half of t1's card: the midpoint rule inserts before it.
    await pointerDrag(
      `${CELL("fakeagent", "settled")} ${CARD(t2)}`,
      `${CELL("fakeagent", "settled")} ${CARD(t1)}`,
      { land: "top" },
    );

    await browser.waitUntil(
      async () => JSON.stringify(await cellCardOrder("fakeagent", "settled")) === JSON.stringify([t2, t1]),
      { timeout: 5_000, timeoutMsg: "board cell never showed the reordered cards" },
    );
    // The store is the same truth the sidebar renders, and task_reorder
    // persists it. t3 (fakecapture lane, same project) keeps its place.
    const storeOrder = (await projectTaskOrder()) as string[];
    expect(storeOrder.indexOf(t2)).toBeLessThan(storeOrder.indexOf(t1));
  });

  it("dragging to another column snaps back with no dialog and no write", async () => {
    await pointerDrag(
      `${CELL("fakeagent", "settled")} ${CARD(t2)}`,
      CELL("fakeagent", "working"),
    );
    // No drop target outside the origin group and the Archived column, so the
    // card stays put and nothing (confirm dialog included) appears.
    const dialogUp = await browser.execute(
      () => !!document.querySelector('[role="dialog"]'),
    );
    expect(dialogUp).toBe(false);
    await waitVisible(`${CELL("fakeagent", "settled")} ${CARD(t2)}`);
    const archived = await browser.execute(
      id => !!window.__termic!.useApp.getState().tasks.find((w: any) => w.id === id)?.archived,
      t2,
    );
    expect(archived).toBe(false);
  });

  it("dropping a card on the Archived column archives it through the real confirm dialog", async () => {
    await dismissOverlays();
    await pointerDrag(
      `${CELL("fakecapture", "settled")} ${CARD(t3)}`,
      "[data-board-archive]",
    );

    // The shared confirmAndArchive dialog, scoped by its title per the suite's
    // dialog rule. Repo-root task, so the confirm label is "Remove entry".
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll('[role="dialog"]')].some(d =>
            d.textContent?.includes('Archive "board-c"')),
        ),
      { timeout: 5_000, timeoutMsg: "archive confirm dialog never appeared" },
    );
    await clickByText("Remove entry");

    // The card moves to the Archived column, the store agrees, and the
    // fakecapture lane goes away with its last live task.
    await waitVisible(`[data-board-archive] ${CARD(t3)}`);
    await waitGone('[data-board-lane="fakecapture"]');
    await browser.waitUntil(
      () =>
        browser.execute(
          id => !!window.__termic!.useApp.getState().tasks.find((w: any) => w.id === id)?.archived,
          t3,
        ),
      { timeout: 10_000, timeoutMsg: "task never landed as archived in the store" },
    );
    await snap("board-after-archive.png");
  });
});
