import { describe, expect, it } from "vitest";
import {
  BOARD_STATE_COLUMNS,
  boardCellGroups,
  boardDropCommand,
  boardLanes,
  taskBoardColumn,
  taskHasClearableWork,
} from "./taskBoardState";
import type { Agent, Tab, Task } from "./types";
import type { WorkStatePrefs } from "./taskWorkState";

const prefsOn: WorkStatePrefs = { settledHighlight: true, workingIndicator: true };
// attentionIndicator is optional and defaults on (upstream split it out of
// settledHighlight), so gating attention off means saying so explicitly.
const prefsOff: WorkStatePrefs = { settledHighlight: false, workingIndicator: false, attentionIndicator: false };

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

  it("merged or closed PRs fall out of review (to backlog while untouched)", () => {
    const w = task({ pr_url: "https://github.com/acme/x/pull/1" });
    expect(taskBoardColumn(w, [], { pr: { state: "merged" } }, prefsOn)).toBe("backlog");
    expect(taskBoardColumn(w, [], { pr: { state: "closed" } }, prefsOn)).toBe("backlog");
    // Touched tabs: the fallback below backlog is settled.
    const touched = [tab({ workState: "done" })];
    expect(taskBoardColumn(w, touched, { pr: { state: "merged" } }, prefsOn)).toBe("settled");
  });

  it("a main checkout never enters review, even with a PR url on the record", () => {
    const w = task({ is_main_checkout: true, pr_url: "https://github.com/acme/x/pull/1" });
    // Touched tabs, so the assertion lands on the exclusion itself (a main
    // checkout with a stale pr_url settles) rather than on untouched-tab
    // backlog placement.
    const touched = [tab({ workState: "done" })];
    expect(taskBoardColumn(w, touched, { pr: { state: "open" } }, prefsOn)).toBe("settled");
  });

  it("a task with no work evidence lands in backlog, not settled", () => {
    // Freshly spawned: no tabs yet, or tabs the classifier never touched.
    expect(taskBoardColumn(task(), [], null, prefsOn)).toBe("backlog");
    expect(taskBoardColumn(task(), [tab({})], null, prefsOn)).toBe("backlog");
    expect(taskBoardColumn(task(), [tab({ workState: undefined, lastInputAt: null })], null, prefsOn)).toBe("backlog");
  });

  it("a finished turn leaves evidence and lands in settled", () => {
    expect(taskBoardColumn(task(), [tab({ workState: "done" })], null, prefsOn)).toBe("settled");
    // Explicit "idle" is a WRITE the state machine only makes when the user
    // watched a done tab or cleared it: evidence of a past turn.
    expect(taskBoardColumn(task(), [tab({ workState: "idle" })], null, prefsOn)).toBe("settled");
    // Direct input evidence, even without classification.
    expect(taskBoardColumn(task(), [tab({ lastInputAt: 1234 })], null, prefsOn)).toBe("settled");
  });

  it("backlog loses to every live signal", () => {
    const untouched = [tab({})];
    const attention = task({ pr_url: null });
    expect(taskBoardColumn(attention, [tab({ unread: { reason: "attention" } })], null, prefsOn)).toBe("attention");
    expect(taskBoardColumn(task(), [tab({ workState: "working" })], null, prefsOn)).toBe("working");
    const withPr = task({ pr_url: "https://github.com/acme/x/pull/1" });
    expect(taskBoardColumn(withPr, untouched, { pr: { state: "open" } }, prefsOn)).toBe("review");
  });

  it("prefs gate the work signals but never the review column", () => {
    const working = task({ pr_url: "https://github.com/acme/x/pull/1" });
    // workingIndicator off: the working signal disappears, PR takes over.
    expect(taskBoardColumn(working, [tab({ workState: "working" })], { pr: { state: "open" } }, prefsOff)).toBe("review");
    const plain = task();
    // Attention gated off and no other evidence: the untouched task shows as
    // backlog, the one state that never depends on prefs.
    expect(taskBoardColumn(plain, [tab({ unread: { reason: "attention" } })], null, prefsOff)).toBe("backlog");
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
  it("is the display order: backlog leads, settled closes the lifecycle", () => {
    expect(BOARD_STATE_COLUMNS).toEqual(["backlog", "attention", "working", "review", "settled"]);
  });
});

describe("boardDropCommand", () => {
  // The hooks map is plain data: true = the agent reports its own state, so
  // a user gesture may not clear its spinner.
  const hooks = { claude: true };

  it("the archived column archives through any source", () => {
    expect(boardDropCommand("settled", "archived", task(), [], hooks)).toEqual({ kind: "archive" });
    expect(boardDropCommand("backlog", "archived", task(), [], hooks)).toEqual({ kind: "archive" });
  });

  it("a drop on settled settles only when there is something to clear", () => {
    // Attention unread, done, and a terminal-read spinner all clear.
    expect(boardDropCommand("attention", "settled", task(),
      [tab({ unread: { reason: "attention" } })], hooks)).toEqual({ kind: "settle" });
    expect(boardDropCommand("attention", "settled", task(),
      [tab({ workState: "done" })], hooks)).toEqual({ kind: "settle" });
    expect(boardDropCommand("review", "settled", task(),
      [tab({ workState: "working" })], {})).toEqual({ kind: "settle" });
    // Nothing clearable: snap back rather than a command that does nothing.
    expect(boardDropCommand("backlog", "settled", task(), [], hooks)).toBeNull();
    expect(boardDropCommand("backlog", "settled", task(), [tab({})], hooks)).toBeNull();
  });

  it("a hooked agent's live spinner is not clearable", () => {
    // Same rule as the focus clear: for an agent that reports its own state
    // the spinner is live truth, and clearing it destroyed state nothing
    // put back for the rest of the turn. The clearable check reads the TAB's
    // cli (real terminal tabs carry it), so the fixture tab has to too.
    expect(boardDropCommand("attention", "settled", task(),
      [tab({ workState: "working", cli: "claude" })], hooks)).toBeNull();
  });

  it("a drop on review opens the PR dialog except from review itself or a main checkout", () => {
    expect(boardDropCommand("settled", "review", task(), [], hooks)).toEqual({ kind: "createPr" });
    expect(boardDropCommand("backlog", "review", task(), [], hooks)).toEqual({ kind: "createPr" });
    // Same gate as the review column: a main checkout never polls a PR, so
    // a created one could never move the card again.
    expect(boardDropCommand("settled", "review", task({ is_main_checkout: true }), [], hooks)).toBeNull();
    // The card is already in review: a drop there is not a command.
    expect(boardDropCommand("review", "review", task(), [], hooks)).toBeNull();
  });

  it("terminal columns and same-column drops are never commands", () => {
    for (const target of ["backlog", "working", "attention"] as const) {
      expect(boardDropCommand("settled", target, task(), [tab({ workState: "done" })], hooks)).toBeNull();
    }
    expect(boardDropCommand("settled", "settled", task(), [tab({ workState: "done" })], hooks)).toBeNull();
    expect(boardDropCommand("attention", "attention", task(),
      [tab({ unread: { reason: "attention" } })], hooks)).toBeNull();
  });
});

describe("taskHasClearableWork", () => {
  it("sees attention, done and a clearable spinner across all terminal tabs", () => {
    expect(taskHasClearableWork([tab({ unread: { reason: "attention" } })], {})).toBe(true);
    expect(taskHasClearableWork([tab({ workState: "done" })], {})).toBe(true);
    expect(taskHasClearableWork([tab({ workState: "working" })], {})).toBe(true);
    // The signal can sit on any tab, not just the first.
    expect(taskHasClearableWork([tab({ id: "a", workState: "idle" }), tab({ id: "b", workState: "done" })], {}))
      .toBe(true);
  });

  it("non-terminal tabs and clean terminal tabs never count", () => {
    expect(taskHasClearableWork([{ id: "d", type: "diff", title: "d", unread: { reason: "attention" } } as Tab], {}))
      .toBe(false);
    expect(taskHasClearableWork([tab({ workState: "idle" }), tab({})], {})).toBe(false);
    expect(taskHasClearableWork([], {})).toBe(false);
  });
});
