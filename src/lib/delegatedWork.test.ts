import { describe, it, expect } from "vitest";
import {
  parseDelegatedBody,
  delegatedVerdict,
  isAgentOwned,
  delegatedChipText,
  DELEGATED_DETACHED_GRACE_MS,
  DELEGATED_LABELS,
  type DelegatedWork,
} from "@/lib/delegatedWork";
import { HOOK_OSC_DELEGATED_PREFIX, hookOscHandlerData, parseNotifyBody } from "@/lib/agentHooks";

/** What the hook actually writes, parsed the way `TerminalPane` parses it, so
 *  these tests exercise the wire and not just the function. */
const onTheWire = (rest: string) => {
  const body = parseNotifyBody(hookOscHandlerData(`${HOOK_OSC_DELEGATED_PREFIX}${rest}`))!;
  return body.startsWith(HOOK_OSC_DELEGATED_PREFIX)
    ? parseDelegatedBody(body.slice(HOOK_OSC_DELEGATED_PREFIX.length))
    : null;
};

describe("the delegated report on the wire", () => {
  it("reads the bodies the hook generates", () => {
    // These three strings are the exact output of the generated shell script,
    // pinned on the Rust side by `a_held_done_reports_what_it_is_holding_for`.
    expect(onTheWire("1 subagent a1")).toEqual({ label: "subagent", count: 1, ids: ["a1"] });
    expect(onTheWire("2 shell b1,b2")).toEqual({ label: "shell", count: 2, ids: ["b1", "b2"] });
    expect(onTheWire("1 work -")).toEqual({ label: "work", count: 1, ids: [] });
  });

  it("covers every label the script can send", () => {
    for (const label of Object.keys(DELEGATED_LABELS)) {
      expect(parseDelegatedBody(`1 ${label} x1`)?.label).toBe(label);
    }
  });

  it("drops a body it does not understand rather than showing it", () => {
    // The body is agent-controlled and reaches a tooltip. It is also TRUSTED,
    // so a parse that let junk through would put it on screen as a needs-you
    // banner instead of being dropped.
    for (const junk of ["", "lots subagent a1", "1 SUBAGENT a1", "1 nonsense a1",
                        "0 shell b1", "1 shell b1;rm -rf /", "1 shell " + "x".repeat(500),
                        "1 subagent a1 extra"]) {
      expect(parseDelegatedBody(junk)).toBeNull();
    }
    // An id list longer than anything real is a payload we misread.
    const many = Array.from({ length: 21 }, (_, i) => `i${i}`).join(",");
    expect(parseDelegatedBody(`21 shell ${many}`)).toBeNull();
  });

  it("tolerates a report with no ids", () => {
    // agy says work is outstanding without saying what. It must still count as
    // a hold, or its turn ends early: the whole point of its guard.
    expect(parseDelegatedBody("1 work -")?.count).toBe(1);
    expect(parseDelegatedBody("1 work")?.ids).toEqual([]);
  });
});

describe("who is waiting", () => {
  it("separates work the agent owns from work it detached", () => {
    // Measured (docs/agent-hooks.md): a subagent resumed the turn by itself
    // after 70s, twice. A backgrounded shell did so once and never the other
    // time, with a byte-identical payload. Only the first is safe to wait on
    // indefinitely.
    for (const label of ["subagent", "workflow", "teammate", "cloud_session", "mcp_task"] as const) {
      expect(isAgentOwned({ label, count: 1, ids: [] })).toBe(true);
    }
    expect(isAgentOwned({ label: "shell", count: 1, ids: [] })).toBe(false);
    // Unknown work waits, which is the side that does not announce over a
    // running agent.
    expect(isAgentOwned({ label: "work", count: 1, ids: [] })).toBe(true);
  });

  it("says how many, in the user's words", () => {
    expect(delegatedChipText({ label: "shell", count: 1, ids: [] })).toBe("1 shell");
    expect(delegatedChipText({ label: "shell", count: 3, ids: [] })).toBe("3 shells");
    expect(delegatedChipText({ label: "cloud_session", count: 2, ids: [] })).toBe("2 cloud sessions");
    expect(delegatedChipText({ label: "work", count: 1, ids: [] })).toBe("1 task");
  });
});

describe("the carried-over rule", () => {
  const w = (ids: string[], label: DelegatedWork["label"] = "shell"): DelegatedWork =>
    ({ label, count: ids.length || 1, ids });
  /** A turn a person asked for, and one the agent's own delegated work
   *  re-invoked it for. The two are the difference between a finished turn
   *  and an orchestration mid-cycle. */
  const ASKED = true, RESUMED = false;

  it("ends a turn whose only outstanding work predates it", () => {
    // THE compounding bug, measured on claude 2.1.278: `sleep 900` backgrounded
    // in turn one, then a one-word turn that used no tools at all reported the
    // identical `Stop` payload and was held exactly the same way. Every later
    // turn in that session was swallowed.
    expect(delegatedVerdict(w(["b1"]), w(["b1"]), ASKED)).toBe("carried");
  });

  it("does NOT end a turn the agent's own work re-invoked it for", () => {
    // The same identical set, and the opposite answer. Measured three
    // background subagents deep: a task notification re-invoked the agent, it
    // stopped 1.5s later with a byte-identical set, and nothing was over. An
    // unchanged set only means "finished" relative to something a person
    // asked for.
    expect(delegatedVerdict(w(["b1"]), w(["b1"]), RESUMED)).toBe("new");
  });

  it("reports a set that SHRANK as work landing, not as a finished turn", () => {
    // Three background tasks report back one at a time and each `Stop` carries
    // the remainder: {a,b,c} then {b,c} then {c}. Every one is a subset of the
    // one before, so a subset test rang "done" with two still running, which
    // is the badge this rule exists to not draw.
    expect(delegatedVerdict(w(["a", "b", "c"]), w(["b", "c"]), ASKED)).toBe("shrank");
    expect(delegatedVerdict(w(["a", "b", "c"]), w(["b", "c"]), RESUMED)).toBe("shrank");
    expect(delegatedVerdict(w(["b", "c"]), w(["c"]), RESUMED)).toBe("shrank");
  });

  it("holds a turn that delegated something new", () => {
    expect(delegatedVerdict(w(["b1"]), w(["b1", "b2"]), ASKED)).toBe("new");
    expect(delegatedVerdict(w(["b1"]), w(["b2"]), ASKED)).toBe("new");
    // Measured: a subagent's own backgrounded shells join the parent's list,
    // so a set can shrink and grow in the same report. Anything new wins.
    expect(delegatedVerdict(w(["a1"]), w(["a1", "s1", "s2"]), RESUMED)).toBe("new");
  });

  it("treats the first report of a pty as new", () => {
    // Nothing has been seen, so nothing can have carried over. Turn one of the
    // measured session is exactly this, and it must hold.
    expect(delegatedVerdict(null, w(["b1"]), ASKED)).toBe("new");
    expect(delegatedVerdict(undefined, w(["b1"]), ASKED)).toBe("new");
  });

  it("falls to new when there is nothing to compare", () => {
    // An agent that reports a hold without ids (agy) can never be read as
    // carried over, so it waits rather than being announced over. The
    // conservative direction, and it must stay that way.
    expect(delegatedVerdict(w(["b1"]), w([], "work"), ASKED)).toBe("new");
    expect(delegatedVerdict(w([], "work"), w([], "work"), ASKED)).toBe("new");
  });

  it("does not care what KIND of work carried over", () => {
    // A subagent still running from a previous turn is as stale as a shell.
    expect(delegatedVerdict(w(["a1"], "subagent"), w(["a1"], "subagent"), ASKED))
      .toBe("carried");
  });
});

// The rule, replayed against the id sequences five real claude sessions
// produced. Ids are transcribed as shapes, never pasted: what matters is how
// the SET moves, which is the only thing the rule reads.
describe("the real traces", () => {
  const run = (stops: Array<{ ids: string[]; asked?: boolean }>) => {
    let prev: DelegatedWork | null = null;
    return stops.map(({ ids, asked = false }) => {
      if (!ids.length) { prev = null; return "done"; }
      const next: DelegatedWork = { label: "shell", count: ids.length, ids };
      const v = delegatedVerdict(prev, next, asked);
      prev = next;
      return v;
    });
  };

  it("three background tasks reporting back one at a time ring ONCE, at the end", () => {
    expect(run([
      { ids: ["a", "b", "c"], asked: true }, // the prompt that launched them
      { ids: ["b", "c"] },                   // first one back
      { ids: ["c"] },                        // second one back
      { ids: [] },                           // the last one: the only bell
    ])).toEqual(["new", "shrank", "shrank", "done"]);
  });

  it("a subagent whose own shells join the parent's list never reads as finished", () => {
    expect(run([
      { ids: ["a1", "a2", "a3"], asked: true },
      { ids: ["a3", "s1", "s2", "s3"] },       // subagents' own sleeps appear
      { ids: ["a3", "s1", "s2", "s3"] },       // identical, 1.5s later
      { ids: ["a3", "s1", "s2", "s3", "p1"] }, // a polling shell it spawned
      { ids: ["s1", "s2", "s3", "p1"] },
    ])).toEqual(["new", "new", "new", "new", "shrank"]);
  });

  it("a dev server left running ends every later turn it used to swallow", () => {
    expect(run([
      { ids: ["x"], asked: true },  // "start the dev server"
      { ids: ["x"], asked: true },  // an unrelated one-word turn
      { ids: ["x"], asked: true },  // and the next, and the next
    ])).toEqual(["new", "carried", "carried"]);
  });
});

describe("the detached grace", () => {
  it("sits between the slowest measured round trip and the liveness ceiling", () => {
    // Below, and a build the agent IS waiting on gets announced over. Above,
    // and it is no better than the 20-minute ceiling it exists to pre-empt
    // (TerminalPane, `absoluteCeilingMs`), which clears the spinner silently.
    expect(DELEGATED_DETACHED_GRACE_MS).toBeGreaterThan(85_000);
    expect(DELEGATED_DETACHED_GRACE_MS).toBeLessThan(1_200_000);
  });
});
