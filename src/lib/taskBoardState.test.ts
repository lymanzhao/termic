import { describe, expect, it } from "vitest";
import {
  BOARD_STATE_COLUMNS,
  boardCellGroups,
  boardLanes,
  taskBoardColumn,
} from "./taskBoardState";
import type { Agent, Tab, Task } from "./types";
import type { WorkStatePrefs } from "./taskWorkState";

const prefsOn: WorkStatePrefs = { settledHighlight: true, workingIndicator: true };
const prefsOff: WorkStatePrefs = { settledHighlight: false, workingIndicator: false };

let taskSeq = 0;
function task(over: Partial<Task> = {}): Task {
  taskSeq += 1;
  return {
    id: `t${taskSeq}`,
    project_id: "p1",
    name: `task ${taskSeq}`,
    branch: `b${taskSeq}`,
    base_branch: "main",
    path: "/tmp/x",
    cli: "claude",
    port: 0,
    created: "2026-09-01T00:00:00Z",
    archived: false,
    ...over,
  } as Task;
}

function tab(over: Partial<Tab>): Tab {
  return { id: "tab1", type: "terminal", title: "t", ...over } as Tab;
}

describe("taskBoardColumn", () => {
  it("archived overrides every other signal", () => {
    const w = task({ archived: true, pr_url: "https://github.com/acme/x/pull/1" });
    const tabs = [tab({ unread: { reason: "attention" } }), tab({ workState: "working" })];
    expect(taskBoardColumn(w, tabs, { pr: { state: "open" } }, prefsOn)).toBe("archived");
  });

  it("attention beats working and review", () => {
    const w = task({ pr_url: "https://github.com/acme/x/pull/1" });
    const tabs = [tab({ unread: { reason: "attention" } }), tab({ workState: "working" })];
    expect(taskBoardColumn(w, tabs, { pr: { state: "open" } }, prefsOn)).toBe("attention");
  });

  it("working beats review", () => {
    const w = task({ pr_url: "https://github.com/acme/x/pull/1" });
    expect(taskBoardColumn(w, [tab({ workState: "working" })], { pr: { state: "open" } }, prefsOn)).toBe("working");
  });

  it("open or draft PR with an idle agent lands in review", () => {
    const w = task({ pr_url: "https://github.com/acme/x/pull/1" });
    expect(taskBoardColumn(w, [], { pr: { state: "open" } }, prefsOn)).toBe("review");
    expect(taskBoardColumn(w, [], { pr: { state: "draft" } }, prefsOn)).toBe("review");
  });

  it("a persisted PR identity counts as review before the first poll resolves", () => {
    const w = task({ pr_number: 7 });
    expect(taskBoardColumn(w, [], null, prefsOn)).toBe("review");
    expect(taskBoardColumn(w, [], { pr: null }, prefsOn)).toBe("review");
  });

  it("merged or closed PRs fall out of review into settled", () => {
    const w = task({ pr_url: "https://github.com/acme/x/pull/1" });
    expect(taskBoardColumn(w, [], { pr: { state: "merged" } }, prefsOn)).toBe("settled");
    expect(taskBoardColumn(w, [], { pr: { state: "closed" } }, prefsOn)).toBe("settled");
  });

  it("a main checkout never enters review, even with a PR url on the record", () => {
    const w = task({ is_main_checkout: true, pr_url: "https://github.com/acme/x/pull/1" });
    expect(taskBoardColumn(w, [], { pr: { state: "open" } }, prefsOn)).toBe("settled");
  });

  it("an idle task with no PR is settled, including a freshly spawned one", () => {
    expect(taskBoardColumn(task(), [], null, prefsOn)).toBe("settled");
    expect(taskBoardColumn(task(), [tab({ workState: "done" })], null, prefsOn)).toBe("settled");
  });

  it("prefs gate the work signals but never the review column", () => {
    const working = task({ pr_url: "https://github.com/acme/x/pull/1" });
    // workingIndicator off: the working signal disappears, PR takes over.
    expect(taskBoardColumn(working, [tab({ workState: "working" })], { pr: { state: "open" } }, prefsOff)).toBe("review");
    const plain = task();
    expect(taskBoardColumn(plain, [tab({ unread: { reason: "attention" } })], null, prefsOff)).toBe("settled");
  });
});

describe("boardLanes", () => {
  const agents = [
    { id: "codex" }, { id: "claude" }, { id: "gemini" },
  ] as Agent[];

  it("lists only lanes with live tasks, in registry order", () => {
    const tasks = [task({ cli: "gemini" }), task({ cli: "claude" })];
    expect(boardLanes(tasks, agents)).toEqual(["claude", "gemini"]);
  });

  it("archived tasks do not keep a lane alive", () => {
    const tasks = [task({ cli: "codex", archived: true }), task({ cli: "claude" })];
    expect(boardLanes(tasks, agents)).toEqual(["claude"]);
  });

  it("unknown cli ids sort alphabetically after the registry lanes", () => {
    const tasks = [task({ cli: "zzz-custom" }), task({ cli: "aaa-custom" }), task({ cli: "claude" })];
    expect(boardLanes(tasks, agents)).toEqual(["claude", "aaa-custom", "zzz-custom"]);
  });

  it("no live tasks means no lanes", () => {
    expect(boardLanes([], agents)).toEqual([]);
  });
});

describe("boardCellGroups", () => {
  it("groups by project in project order, preserving task order within a group", () => {
    const a1 = task({ project_id: "pa" });
    const b1 = task({ project_id: "pb" });
    const a2 = task({ project_id: "pa" });
    const groups = boardCellGroups([a1, b1, a2], ["pa", "pb"]);
    expect(groups.map(g => g.projectId)).toEqual(["pa", "pb"]);
    expect(groups[0].tasks.map(t => t.id)).toEqual([a1.id, a2.id]);
  });

  it("unknown projects sink to the bottom instead of crashing", () => {
    const gone = task({ project_id: "deleted" });
    const known = task({ project_id: "pa" });
    const groups = boardCellGroups([gone, known], ["pa"]);
    expect(groups.map(g => g.projectId)).toEqual(["pa", "deleted"]);
  });
});

describe("BOARD_STATE_COLUMNS", () => {
  it("is the display order: attention first, settled last", () => {
    expect(BOARD_STATE_COLUMNS).toEqual(["attention", "working", "review", "settled"]);
  });
});
