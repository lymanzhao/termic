import { describe, it, expect } from "vitest";
import {
  HOOK_OSC_BODY,
  HOOK_OSC_TITLE,
  hookOscSequence,
  hookOscPayload,
  hookOscHandlerData,
  parseNotifyBody,
  CLAUDE_TERMINAL_SEQUENCE_ALLOWLIST,
  HOOK_OSC_READY_BODY,
  HOOK_OSC_WORKING_BODY,
  HOOK_OSC_DONE_BODY,
  HOOK_OSC_SESSION_PREFIX,
  HOOK_OSC_DELEGATED_PREFIX,
  sessionHolder,
} from "@/lib/agentHooks";
import { notificationWantsAttention, BUILTIN_NOTIFY_IGNORE } from "@/lib/agents";

// The whole feature is one OSC sequence surviving one filter. If the body ever
// starts matching claude's ignore list, the hook keeps firing perfectly and
// termic silently drops it: no error, no log, just the old false "done" back.
// These tests are the only thing standing between that and a release.

describe("agent hook OSC sequence", () => {
  it("survives the notification filter it has to pass", () => {
    expect(notificationWantsAttention("claude", HOOK_OSC_BODY, [])).toBe(true);
  });

  it("does not match claude's ignore list", () => {
    // claude sends "is waiting for your input" 60s after EVERY unanswered turn,
    // which is why that phrase is ignored. Our body must not collide with it.
    for (const pattern of BUILTIN_NOTIFY_IGNORE.claude ?? []) {
      expect(new RegExp(pattern).test(HOOK_OSC_BODY)).toBe(false);
    }
    expect(HOOK_OSC_BODY).not.toContain("is waiting for your input");
  });

  it("parses back to exactly the body the filter sees", () => {
    // The end-to-end chain: what the hook writes -> what xterm hands the
    // handler -> what notifyAttention filters. Pinning only the constant would
    // miss a change to the sequence's shape.
    const data = hookOscHandlerData(); // exactly what xterm gives the handler
    expect(parseNotifyBody(data)).toBe(HOOK_OSC_BODY);
    expect(notificationWantsAttention("claude", parseNotifyBody(data)!, [])).toBe(true);
  });

  it("uses an OSC id claude is willing to write", () => {
    // Outside the allowlist the sequence is dropped with no error at all.
    expect(CLAUDE_TERMINAL_SEQUENCE_ALLOWLIST).toContain(777);
    expect(hookOscPayload().startsWith("777;notify;")).toBe(true);
    // Raw control bytes in source are how the sequence got mangled once
    // already, so pin that the wrapper uses real ESC/BEL and nothing else does.
    expect(hookOscSequence()).toBe(`\x1b]${hookOscPayload()}\x07`);
    expect(hookOscPayload()).not.toMatch(/[\x00-\x1f]/);
  });

  it("keeps the title and body in separate fields", () => {
    // `notify` handlers take parts[1] as the title and the REST as the body, so
    // a semicolon in the body is fine but the title must stay one field or the
    // body silently shifts.
    expect(HOOK_OSC_TITLE).not.toContain(";");
    expect(parseNotifyBody(hookOscHandlerData("multi;part;body"))).toBe("multi;part;body");
  });

  it("keeps the delegated report apart from every other body", () => {
    // All five share OSC 777 and the trusted `termic` title, and the handler
    // tells them apart by body alone: ready and the turn edges on an exact
    // match, the session id and this one by prefix. A body that is a prefix of
    // another routes to the wrong arm, and a trusted body that routes nowhere
    // reaches the user as a banner.
    for (const other of [HOOK_OSC_BODY, HOOK_OSC_READY_BODY, HOOK_OSC_WORKING_BODY,
                         HOOK_OSC_DONE_BODY, HOOK_OSC_SESSION_PREFIX]) {
      expect(HOOK_OSC_DELEGATED_PREFIX.startsWith(other)).toBe(false);
      expect(other.startsWith(HOOK_OSC_DELEGATED_PREFIX)).toBe(false);
    }
    // Pinned against DELEGATED_BODY_PREFIX in agent_hooks.rs: the halves of
    // one contract, in two languages that cannot share a constant.
    expect(HOOK_OSC_DELEGATED_PREFIX).toBe("agent delegated: ");
    // And it must survive the same filter every body here survives.
    for (const pattern of BUILTIN_NOTIFY_IGNORE.claude ?? []) {
      expect(new RegExp(pattern).test(HOOK_OSC_DELEGATED_PREFIX)).toBe(false);
    }
  });

  it("ignores an OSC 777 that is not a notify", () => {
    expect(parseNotifyBody("something;else")).toBeNull();
  });

  // The failure this catches is the nastiest kind: everything keeps working
  // except the feature, with no error anywhere. A user who teaches termic what
  // their agent says when it needs them sets an `attention` list, and that list
  // is an ALLOW-LIST, so our body stops matching and the hook is dropped.
  // `TerminalPane` therefore trusts OSC 777 by its TITLE field, not its body.
  // Found by the e2e fixture, which seeds exactly such a list for fakeagent.
  it("would be filtered out by a user's attention allow-list, hence the title", () => {
    const withAllowList = [{
      id: "claude", display_name: "claude", command: "claude", args: [],
      icon_id: "claude", color: "#000", builtin: true,
      capabilities: { signals: { attention: ["needs your permission"] } },
    }] as unknown as Parameters<typeof notificationWantsAttention>[2];

    expect(notificationWantsAttention("claude", HOOK_OSC_BODY, withAllowList)).toBe(false);
    // ...which is exactly why the sender is identified by the title field.
    expect(hookOscPayload().split(";")[2]).toBe(HOOK_OSC_TITLE);
  });

  it("is stable, because the Rust side pins the same literal", () => {
    // agent_hooks::script_body() writes this exact text. Changing it here
    // without changing it there produces a hook that fires and does nothing.
    expect(HOOK_OSC_BODY).toBe("agent needs your input");
    expect(HOOK_OSC_TITLE).toBe("termic");
  });
});

describe("termic's own turn bodies", () => {
  it("pins the bodies the Rust hooks write", async () => {
    const m = await import("./agentHooks");
    // KEEP IN SYNC with agent_hooks::WORKING_BODY / DONE_BODY.
    expect(m.HOOK_OSC_WORKING_BODY).toBe("agent working");
    expect(m.HOOK_OSC_DONE_BODY).toBe("agent done");
    // Exact-match routed next to ready and attention: none may equal another.
    const all = [m.HOOK_OSC_WORKING_BODY, m.HOOK_OSC_DONE_BODY, m.HOOK_OSC_READY_BODY, m.HOOK_OSC_BODY];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("hookOscSessionId accepts devin's slugs", () => {
  it("takes a UUID or a slug, and nothing that could reach a command line as more", async () => {
    const { hookOscSessionId } = await import("./agentHooks");
    expect(hookOscSessionId("session brassy-polish")).toBe("brassy-polish");
    expect(hookOscSessionId("session 66666666-7777-4888-9999-aaaaaaaaaaaa")).toBe("66666666-7777-4888-9999-aaaaaaaaaaaa");
    for (const bad of ["session -rf", "session a b", "session a;b", "session $(x)", "session ", "session _x"]) {
      expect(hookOscSessionId(bad), bad).toBeNull();
    }
  });
});

describe("an agent's own end-of-turn notification is not a request", () => {
  it("does not badge grok's 'Turn complete' or devin's 'Devin finished'", () => {
    expect(notificationWantsAttention("grok", "Turn complete in 3.5s. · Repeated greetings", [])).toBe(false);
    expect(notificationWantsAttention("devin", "Devin finished", [])).toBe(false);
    expect(notificationWantsAttention("muse", "my-repo \u2014 done (18s)", [])).toBe(false);
    expect(notificationWantsAttention("muse", "Muse needs your approval to run a command", [])).toBe(true);
    // A permission request from grok still is one.
    expect(notificationWantsAttention("grok", "Grok needs your permission to run bash", [])).toBe(true);
  });
});

// A reported session id another tab already holds is not this tab's to keep.
// Main-checkout tasks share a cwd, so claude's picker lists the siblings'
// conversations, newest first; storing the pick swapped two tasks.
describe("sessionHolder", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const self = { taskId: "t-b", tabId: "tab-b" };
  const term = (id: string, sessionId?: string) =>
    ({ id, type: "terminal", cli: "claude", title: "", sessionId }) as any;
  const task = (id: string, name: string, extra: any = {}) =>
    ({ id, name, archived: false, persisted_tabs: [], ...extra });

  it("names the task whose live tab holds the id", () => {
    const tasks = [task("t-a", "alpha"), task("t-b", "bravo")];
    const tabs = { "t-a": [term("tab-a", A)], "t-b": [term("tab-b", B)] };
    expect(sessionHolder(A, self, tasks, tabs)).toEqual({ taskId: "t-a", taskName: "alpha", tabId: "tab-a" });
  });

  it("finds a holder that was never opened this run, through its persisted tabs", () => {
    const tasks = [task("t-a", "alpha", { persisted_tabs: [{ id: "tab-a", session_id: A }] }), task("t-b", "bravo")];
    expect(sessionHolder(A, self, tasks, {})?.taskName).toBe("alpha");
  });

  it("a second tab in the SAME task is a holder too", () => {
    const tasks = [task("t-b", "bravo")];
    const tabs = { "t-b": [term("tab-b"), term("tab-b2", A)] };
    expect(sessionHolder(A, self, tasks, tabs)?.tabId).toBe("tab-b2");
  });

  it("the reporting tab's own id, an unheld id, and an archived holder are all free", () => {
    const tasks = [
      task("t-b", "bravo", { persisted_tabs: [{ id: "tab-b", session_id: B }] }),
      task("t-old", "old", { archived: true, persisted_tabs: [{ id: "tab-o", session_id: A }] }),
    ];
    const tabs = { "t-b": [term("tab-b", B)] };
    expect(sessionHolder(B, self, tasks, tabs)).toBe(null);
    expect(sessionHolder("cccccccc-cccc-4ccc-8ccc-cccccccccccc", self, tasks, tabs)).toBe(null);
    expect(sessionHolder(A, self, tasks, tabs)).toBe(null);
  });
});
